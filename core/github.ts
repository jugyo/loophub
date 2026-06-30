// #411: the gh/git seam for submitting a loophub PR to GitHub as a Draft PR. Kept separate from
// service.ts so the orchestration there (push → create/recover → record) can be unit-tested with
// these injected — `gh` and a GitHub remote are not available in CI. service.ts composes the real
// implementations via `realGithubDeps`; tests pass fakes.
import { execFile } from "node:child_process";
import { git } from "./git.ts";

export interface GhPr {
  number: number;
  url: string;
}

// Push the internal head branch's commits to origin under `branch`, WITHOUT `-u`: setting upstream
// would rewrite the local head's tracking to the GitHub branch and disturb the loophub-managed
// branch (a later bare `git push` in the worktree could then target GitHub). Idempotent — pushing
// the same commits again is a no-op, so a retry after a partial run is safe.
export async function pushBranch(
  repoPath: string,
  headRef: string,
  branch: string,
): Promise<void> {
  const r = await git(repoPath, [
    "push",
    "origin",
    `${headRef}:refs/heads/${branch}`,
  ]);
  if (r.code !== 0)
    throw new Error(`git push failed: ${r.stderr.trim() || r.stdout.trim()}`);
}

function gh(
  repoPath: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        cwd: repoPath,
        env: process.env,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? (err as { code: number }).code
            : err
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

// Look up an existing PR for `branch`, or null when none exists. Used to recover from a partial
// run that created the PR on GitHub but failed before recording it: a retry finds the existing PR
// instead of opening a duplicate (#406's worst state). `branch` is passed after `--` so a value can
// never be mistaken for a flag (the caller also validates the charset). Distinguishes a genuinely
// absent PR (→ null, so the recovery path creates one) from a transient gh failure (auth/network →
// throw) so a flaky `pr view` on retry does not masquerade as "no PR" and bypass recovery.
export async function viewPr(
  repoPath: string,
  branch: string,
): Promise<GhPr | null> {
  const r = await gh(repoPath, [
    "pr",
    "view",
    "--json",
    "number,url",
    "--",
    branch,
  ]);
  if (r.code !== 0) {
    // Only a genuinely-absent PR maps to null (so recovery creates one). "no pull requests found"
    // covers an existing branch with no PR; "Could not resolve to a PullRequest" covers a bad branch.
    // Keep the second alternative PR-specific — an unanchored "Could not resolve to a" would also
    // swallow "…to a Repository" (wrong-repo / no-access), which must throw, not look like "no PR".
    if (
      /no .*pull requests? found|Could not resolve to a PullRequest/i.test(
        r.stderr,
      )
    )
      return null;
    throw new Error(`gh pr view failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  try {
    const j = JSON.parse(r.stdout);
    if (typeof j.number === "number" && typeof j.url === "string")
      return { number: j.number, url: j.url };
  } catch {
    // fall through
  }
  return null;
}

// Create a Draft GitHub PR for `head` against `base`. Resolves the new PR's number+url via a
// follow-up `pr view` (authoritative), falling back to parsing the URL `gh pr create` prints.
export async function createDraftPr(
  repoPath: string,
  input: { base: string; head: string; title: string; body: string },
): Promise<GhPr> {
  const created = await gh(repoPath, [
    "pr",
    "create",
    "--draft",
    "--base",
    input.base,
    "--head",
    input.head,
    "--title",
    input.title,
    "--body",
    input.body,
  ]);
  if (created.code !== 0)
    throw new Error(
      `gh pr create failed: ${created.stderr.trim() || created.stdout.trim()}`,
    );
  // Prefer the authoritative number/url from `pr view`, but never let a flaky view fail a PR that
  // was just created — fall back to parsing the URL `pr create` printed.
  let view: GhPr | null = null;
  try {
    view = await viewPr(repoPath, input.head);
  } catch {
    view = null;
  }
  if (view) return view;
  const url = created.stdout.trim().split(/\s+/).pop() ?? "";
  const m = url.match(/\/pull\/(\d+)/);
  if (m) return { number: Number(m[1]), url };
  throw new Error(
    `could not resolve created PR from gh output: ${created.stdout.trim()}`,
  );
}

export interface GithubDeps {
  push: typeof pushBranch;
  view: typeof viewPr;
  create: typeof createDraftPr;
}

export const realGithubDeps: GithubDeps = {
  push: pushBranch,
  view: viewPr,
  create: createDraftPr,
};
