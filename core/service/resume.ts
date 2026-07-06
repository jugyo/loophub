import {
  branchExists,
  canonicalPath,
  decideResume,
  issueOr404,
  legacyWorktreePath,
  RUNTIME_CLAUDE_CODE,
  repoOr404,
  resolveRuntimeResume,
  resolveWorktreeIdentity,
  S,
  sessionRuntime,
  worktreeList,
  worktreePath,
  worktreeRoot,
} from "./shared.ts";

// ===== resume (re-enter a PR's dev session) =====
//
// Resolve everything `lh resume <PR id>` needs to relaunch the Claude session that was used to
// develop a PR: the stored Claude session id and the worktree/branch to run it in. State
// resolution (DB + git) lives here; the restorability judgment is the pure decideResume. The CLI
// performs the actual worktree provisioning (provisionWorktree) and `claude --resume` spawn.
export interface ResumeOk {
  ok: true;
  pr: number;
  worktreeScheme: "pr" | "legacy-issue"; // naming convention for the worktree path/branch (#463)
  worktreeNumber: number; // PR number ("pr" scheme) or issue number ("legacy-issue" scheme)
  branch: string; // PR head ref to check out
  runtime: string; // session runtime that selects the resume command (e.g. "claude-code")
  sessionId: string; // runtime session id for the resume command (e.g. `claude --resume <id>`)
  restore: boolean; // true => worktree was removed; re-attach it from the branch
}
export interface ResumeFail {
  ok: false;
  pr: number;
  reason: "no-session" | "unrestorable" | "unknown-runtime";
  branch: string; // PR head ref (named in the "unrestorable" message)
  runtime?: string | null; // the unsupported runtime, when reason is "unknown-runtime"
}
export type ResumeResolution = ResumeOk | ResumeFail;

// Resolve a resume by *session id* rather than by PR (#299). An issue-create session has no PR and
// no dev worktree — it is just a Claude session that filed an issue — so `lh resume --session <id>`
// re-enters it with `claude --resume <id>` in the repo root, bypassing the worktree machinery that
// `resume.resolve` (PR path) needs. Only the runtime check applies: a non-resumable runtime or a
// missing/non-UUID id is reported so the CLI can explain it.
export type SessionResumeResolution =
  | { ok: true; runtime: string; sessionId: string }
  | { ok: false; reason: "not-found" | "no-session" | "unknown-runtime" };

export const resume = {
  async resolve(name: string, prNumber: number): Promise<ResumeResolution> {
    const r = repoOr404(name);
    const prRow = issueOr404(r, prNumber, "pull");
    const pull = S.getPull(prRow.id)!;
    const headRef: string = pull.head_ref;

    // The PR's resume anchor is the latest kind='dev' session linked to it in session_links (#316),
    // recorded when `lh dev` opened the PR (the `lh dev <issue>` flow) or re-entered it directly
    // (`lh dev <pr>`). #186 removed the old issue-assignee fallback — the PR is the single source of
    // truth; #316 derives it from session_links instead of a denormalized pulls.session_id column.
    const sessionRowId: string | null = S.primaryDevSessionForPull(prRow.id);
    const sessionRow = sessionRowId ? S.getAgentSession(sessionRowId) : null;
    // The session's runtime selects how to resume it. Prefer the explicit runtime column; fall back
    // to "lh-dev agent + no runtime → claude-code" for sessions registered before the column
    // existed (sessionRuntime). resolveRuntimeResume then validates the stored id for that runtime —
    // claude-code needs a UUID for `claude --resume <id>` (guards argv injection); a runtime this
    // build cannot resume (e.g. a future codex session) is reported as unknown-runtime so the CLI
    // can explain it rather than mislabel it "no session".
    const runtime = sessionRuntime(sessionRow);
    const runtimeResume = resolveRuntimeResume(
      runtime,
      sessionRow?.external_session ?? null,
    );
    if (!runtimeResume.ok && runtimeResume.reason === "unknown-runtime") {
      return {
        ok: false,
        pr: prNumber,
        reason: "unknown-runtime",
        branch: headRef,
        runtime,
      };
    }
    const claudeSessionId: string | null = runtimeResume.ok
      ? runtimeResume.sessionId
      : null;

    const identity = resolveWorktreeIdentity(headRef, prNumber);
    const path =
      identity.scheme === "legacy-issue"
        ? legacyWorktreePath(worktreeRoot(), r.full_name, identity.number)
        : worktreePath(worktreeRoot(), r.full_name, identity.number);
    const worktrees = await worktreeList(r.local_path);
    const worktreeExists = worktrees.some(
      (w) => canonicalPath(w.path) === canonicalPath(path),
    );
    const branchPresent = await branchExists(r.local_path, headRef);

    const decision = decideResume({
      sessionId: claudeSessionId,
      worktreeExists,
      branchExists: branchPresent,
    });
    if (!decision.ok) {
      return {
        ok: false,
        pr: prNumber,
        reason: decision.reason,
        branch: headRef,
      };
    }
    return {
      ok: true,
      pr: prNumber,
      worktreeScheme: identity.scheme,
      worktreeNumber: identity.number,
      branch: headRef,
      // decision.ok ⇒ claudeSessionId is non-null ⇒ runtimeResume.ok, so its runtime is set.
      runtime: runtimeResume.ok ? runtimeResume.runtime : RUNTIME_CLAUDE_CODE,
      sessionId: claudeSessionId as string,
      restore: decision.restore,
    };
  },

  // Resolve a session-id resume (#299). Used by `lh resume --session <id>` for sessions that are not
  // a PR's dev session — chiefly the `issue-create` session a New Issue flow records (`lh issue
  // new`). No worktree/branch facts are needed: a resumable Claude session re-enters with
  // `claude --resume <external_session>` in the repo root, so this returns just the runtime + id.
  resolveSession(sessionId: string): SessionResumeResolution {
    const row = S.getAgentSession(sessionId);
    if (!row) return { ok: false, reason: "not-found" };
    const runtimeResume = resolveRuntimeResume(
      sessionRuntime(row),
      row.external_session ?? null,
    );
    if (!runtimeResume.ok) return { ok: false, reason: runtimeResume.reason };
    return {
      ok: true,
      runtime: runtimeResume.runtime,
      sessionId: runtimeResume.sessionId,
    };
  },
};
