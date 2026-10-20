import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import {
  fetchRemote,
  git,
  isAncestor,
  localBranchRef,
  remoteUrl,
  worktreeList,
} from "../git.ts";
import * as S from "../store.ts";
import type { WorkflowContractLanguage } from "../workflow/contracts.ts";
import { worktreeBranch } from "../worktree-path.ts";
import { pulls } from "./pulls.ts";
import {
  actorFor,
  assertExistingLocalBranch,
  ensureWritable,
  issueOr404,
  repoOr404,
} from "./shared.ts";

function defaultPrTitle(
  issue: number,
  language: WorkflowContractLanguage,
): string {
  return language === "ja"
    ? `Issue #${issue} を実装する`
    : `Implement issue #${issue}`;
}

function defaultPrBody(
  issue: number,
  language: WorkflowContractLanguage,
): string {
  const [planIntro, planDetails, visualEvidence] =
    language === "en"
      ? [
          "<!-- Before editing source, briefly update this section with the implementation plan.",
          "Include: files/areas to change, existing APIs/components/modules to reuse, scope boundaries, and tests to update or run. -->",
          "- **Visual evidence gate**: TODO - record `UI / visual candidate: yes|no`; for `yes`, include screenshot evidence or a specific `N/A` reason.",
        ]
      : [
          "<!-- Execute ステップはソース編集前にここを短い実装プランで更新してください。",
          "含める内容: 変更予定ファイル/領域、再利用する既存 API/component/module、スコープ境界、更新・実行するテスト。 -->",
          "- **Visual evidence gate**: TODO - `UI / visual candidate: yes|no` を記録する。`yes` の場合はスクリーンショット、または具体的な `N/A` の理由を記載する。",
        ];

  return [
    "## Implementation plan",
    "",
    planIntro,
    planDetails,
    "",
    "## Evidence",
    "",
    visualEvidence,
    "",
    `Closes #${issue}`,
    "",
  ].join("\n");
}

// Bring a local branch up to `origin/<branch>` before a new PR records it as its base (#601), so a
// fresh worktree does not fork from a stale checkout and the PR's base stays the branch it forked
// from. A repo without an origin keeps using the local branch as-is. A local branch that is already
// up to date or ahead is left alone. Every failure — an unreachable remote, a diverged branch, a
// dirty checkout the merge would overwrite — is reported with git's own message, never recovered.
async function fastForwardFromOrigin(
  repoPath: string,
  branch: string,
): Promise<void> {
  if (!(await remoteUrl(repoPath))) return;
  const fetched = await fetchRemote(repoPath);
  if (fetched.code !== 0) {
    const detail =
      fetched.stderr.trim() || fetched.stdout.trim() || "unknown error";
    throw new ServiceError(422, `git fetch origin failed: ${detail}`);
  }
  const remoteRef = `refs/remotes/origin/${branch}`;
  if (await isAncestor(repoPath, remoteRef, localBranchRef(branch))) return;
  // git refuses to move a branch checked out in some worktree by ref update alone, so that
  // checkout fast-forwards with a merge; otherwise a local fetch updates the ref, which git also
  // limits to fast-forwards.
  const checkout = (await worktreeList(repoPath)).find(
    (w) => w.branch === branch,
  );
  const updated = checkout
    ? await git(checkout.path, ["merge", "--ff-only", "--quiet", remoteRef])
    : await git(repoPath, [
        "fetch",
        "--quiet",
        ".",
        `${remoteRef}:${localBranchRef(branch)}`,
      ]);
  if (updated.code !== 0) {
    const detail =
      updated.stderr.trim() || updated.stdout.trim() || "unknown error";
    throw new ServiceError(
      422,
      `cannot fast-forward ${branch} to origin/${branch}: ${detail}`,
    );
  }
}

// ===== dev (issue-dev loop support) =====
//
// Helpers for the development loop shared by Workflow runs: open a PR at the start of work and
// attribute the dev session to it.

export const dev = {
  // Open the PR for an issue's worktree branch at the start of a run. Idempotent:
  // if the issue already has an open (unmerged) linked PR, return it untouched. The PR can
  // be opened with 0 commits — LoopHub does not require head to be ahead of base (the diff
  // is just empty until the agent commits). The body seeds a plan placeholder the agent
  // overwrites; `Closes #<n>` links it both ways. The run launcher calls this *before* provisioning
  // the worktree (#463) so the PR number is known first; head defaults to the PR-id branch
  // convention (worktreeBranch), derived from the PR's own number once assigned — pass an
  // explicit `head` only to override it (e.g. tests simulating a specific branch).
  //
  // `opts.attributeSession` (default true) gates re-pointing an *existing, reused* PR's session
  // pointer (setPullSession) at `sessionId`. The launcher needs the PR number before it can claim
  // its (PR-keyed, #463) dev lock, so it calls this before the lock exists — pass `false` there to
  // defer the write until after the lock is won, so a losing concurrent run racing on the
  // same already-open PR can never overwrite the winner's session pointer.
  //
  // `input.syncBaseFromOrigin` fast-forwards a new PR's base from origin before the PR records it,
  // when that base is the repo's default branch (#601). A reused PR keeps its recorded base.
  async openPr(
    name: string,
    input: {
      issue: number;
      head?: string;
      base?: string;
      body?: string;
      language?: WorkflowContractLanguage;
      syncBaseFromOrigin?: boolean;
    },
    sessionId?: string | null,
    opts: { attributeSession?: boolean } = {},
  ): Promise<{ created: boolean; number: number }> {
    const attributeSession = opts.attributeSession ?? true;
    const r = repoOr404(name);
    ensureWritable(r);
    const issueRow = issueOr404(r, input.issue, "issue");
    const existing = S.openPullLinkedToIssue(issueRow.id);
    if (existing) {
      // Re-running against an issue reuses the open PR but must re-point it at the session it is
      // about to spawn (latest-writer-wins), so usage/retro resolve the current session rather
      // than a stale one. (The old model re-assigned the issue on every run.)
      if (sessionId && attributeSession) {
        db.transaction(() => {
          S.setPullSession(existing.id, sessionId);
          // setPullSession also appends the session to session_links (#298) — the PR's related-sessions
          // list and the prior session's now-"superseded" verdict change here. Emit a PR-scoped event so
          // the open detail refreshes (the create path below gets this via pull_request.opened).
          S.emitEvent(r.id, "pull_request.updated", actorFor(sessionId), {
            number: existing.number,
          });
        });
      }
      return { created: false, number: existing.number };
    }
    if (input.base == null && issueRow.target_branch) {
      assertExistingLocalBranch(r.local_path, issueRow.target_branch);
    }
    const base = input.base ?? issueRow.target_branch ?? r.default_branch;
    if (input.syncBaseFromOrigin && base === r.default_branch) {
      await fastForwardFromOrigin(r.local_path, base);
    }
    const body =
      input.body ?? defaultPrBody(input.issue, input.language ?? "ja");
    const pr = await pulls.create(
      name,
      {
        title: input.language
          ? defaultPrTitle(input.issue, input.language)
          : issueRow.title,
        body,
        head: input.head,
        headFromNumber: input.head
          ? undefined
          : (number) => worktreeBranch(name, number),
        base,
        issue: input.issue,
      },
      sessionId,
    );
    return { created: true, number: pr.number };
  },

  // Attribute a dev session to an existing PR (via session_links, #316) so usage/retro can
  // later find it. Used to attribute the session to a *reused* open PR — deferred here until after
  // the caller's PR-keyed dev lock is won (see dev.openPr's `attributeSession` option), so a losing
  // concurrent launch can never overwrite the winner's pointer. Emits the same `pull_request.updated`
  // event openPr's reuse branch does, so polling refreshes the PR detail's related-sessions list
  // here too. Latest linked dev session wins.
  attachSession(
    name: string,
    number: number,
    sessionId: string,
  ): { number: number } {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    if (sessionId) {
      db.transaction(() => {
        S.setPullSession(row.id, sessionId);
        S.emitEvent(r.id, "pull_request.updated", actorFor(sessionId), {
          number: row.number,
        });
      });
    }
    return { number: row.number };
  },
};
