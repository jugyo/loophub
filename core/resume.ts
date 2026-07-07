// Pure decision logic for `lh resume <PR id>` (cli/index.ts → core/service.ts resume.resolve).
// Kept free of git/DB side effects so the "can this PR's session be resumed, and does its
// worktree need restoring?" judgment is unit-testable in isolation; the service layer feeds it
// the resolved session id and the on-disk worktree/branch facts.
import { issueNumberFromBranch } from "./worktree-prune.ts";

// The naming scheme that identifies where a PR's `lh build` worktree lives on disk. "pr" is the
// current (#463+) convention (core/worktree-path.ts worktreeBranch/worktreePath); "legacy-issue"
// is the pre-#463 convention (legacyWorktreeBranch/legacyWorktreePath), kept recognizable so a
// worktree provisioned before this change is not orphaned.
export type WorktreeScheme = "pr" | "legacy-issue";

export interface WorktreeIdentity {
  scheme: WorktreeScheme;
  number: number; // issue number for "legacy-issue", PR number for "pr"
}

// Facts the service resolves before deciding (DB + git):
//   sessionId      — the Claude session id stored for the PR's dev session (agent_sessions
//                    .external_session), or null when none was ever recorded.
//   worktreeExists — a registered git worktree already sits at the deterministic path.
//   branchExists   — the PR's head branch still exists (so a removed worktree can be re-attached).
export interface ResumeInputs {
  sessionId: string | null;
  worktreeExists: boolean;
  branchExists: boolean;
}

// `restore: false` → reuse the existing worktree as-is; `true` → re-attach it from the branch
// (provisionWorktree-equivalent, idempotent). The two failure reasons map to the user-facing
// guidance: "no-session" (nothing to resume) and "unrestorable" (worktree and branch both gone).
export type ResumeDecision =
  | { ok: true; restore: boolean }
  | { ok: false; reason: "no-session" | "unrestorable" };

// Safety/usefulness order: without a session id there is nothing to resume; an existing worktree
// is always reusable; otherwise a surviving branch lets us restore; with neither, give up cleanly.
export function decideResume(input: ResumeInputs): ResumeDecision {
  if (!input.sessionId) return { ok: false, reason: "no-session" };
  if (input.worktreeExists) return { ok: true, restore: false };
  if (input.branchExists) return { ok: true, restore: true };
  return { ok: false, reason: "unrestorable" };
}

// The agent label `lh build` registers its session under (cli/index.ts `sessions.register`). A
// resumable Claude session is specifically one `lh build` launched: it registers under this agent and
// stores the exact UUID it handed to `claude --session-id`. Another agent's external_session (e.g.
// an impl-bot's runtime id) is that agent's own id, not a Claude session id, so resume must accept
// only sessions registered under this agent — UUID shape alone does not prove Claude provenance.
export const LH_BUILD_SESSION_AGENT = "lh-build";
export const LEGACY_LH_DEV_SESSION_AGENT = "lh-dev";

// The agent label and session kind for the New Issue AI flow (#299). `lh issue new` registers the
// issue-create session under this agent with kind=SESSION_KIND_ISSUE_CREATE so it surfaces in the
// created issue's related-sessions list and is resumable via `claude --resume`.
export const LH_ISSUE_CREATE_SESSION_AGENT = "lh-issue-create";
export const SESSION_KIND_ISSUE_CREATE = "issue-create";

// Env var carrying the issue-create session id from `lh issue new` into the spawned Claude session.
// A `lh issue create` run inside that session reads it and links the session to the issue it files
// (#299) — the issue number is unknown at launch, so the link is recorded after creation.
export const ENV_ISSUE_CREATE_SESSION = "LOOPHUB_ISSUE_CREATE_SESSION";

// Correlates the Herdr pane created by the web New Issue launcher with the issue later filed
// inside that pane. The pane id is only known after `herdr agent start` returns; the issue number
// is only known after `lh issue create`, so both sides upsert against this launch id.
export const ENV_ISSUE_CREATE_HERDR_LAUNCH =
  "LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH";

// A Claude session id is a UUID (`claude --session-id` requires one; `lh build` stores the exact
// UUID it generates). `lh resume` reads a *stored* id and feeds it to `claude --resume <id>`, so
// validate the shape before it reaches argv: claude's `-r, --resume [value]` takes an OPTIONAL
// value, meaning a token starting with `-` would be misparsed as a separate flag rather than the
// resume target (argv/flag injection). Anything not UUID-shaped is not a resumable Claude session.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isClaudeSessionId(id: string | null | undefined): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

// ===== runtime (which agent runtime a session was launched in) =====
//
// A session's runtime decides how `lh resume` re-enters it. Before #164 the runtime was *inferred*
// from the agent label (LH_BUILD_SESSION_AGENT == Claude Code); sessions now carry an explicit
// runtime so resume stays correct once `lh build` can launch other runtimes (codex, ...). Only
// claude-code is actually resumable today — real multi-runtime support is out of scope for #164.
export const RUNTIME_CLAUDE_CODE = "claude-code";
// `lh build --codex` launches the dev session in Codex instead (#458). Codex sessions are recorded
// with this runtime but are not resumable by `lh resume` (resolveRuntimeResume reports
// unknown-runtime) — Codex resume support is a separate step.
export const RUNTIME_CODEX = "codex";

// The effective runtime of a session row, with backward-compat for sessions registered before the
// runtime column existed. A null-runtime row registered under the build/dev session agent predates
// the column and — by that era's invariant ("lh build always launched Claude Code") — was a
// claude-code session, so treat it as claude-code. Any other null-runtime row has unknown provenance
// (null).
// An explicit runtime always wins over the fallback.
export function sessionRuntime(
  row: { runtime?: string | null; agent?: string | null } | null | undefined,
): string | null {
  if (!row) return null;
  if (row.runtime) return row.runtime;
  if (
    row.agent === LH_BUILD_SESSION_AGENT ||
    row.agent === LEGACY_LH_DEV_SESSION_AGENT
  )
    return RUNTIME_CLAUDE_CODE;
  return null;
}

// Decide whether a session can be resumed from its runtime + stored external session id, and (when
// it can) the validated id `lh resume` hands to that runtime's resume command:
//   - claude-code: resumable iff the id is UUID-shaped (claude --resume <uuid>); else no-session.
//   - null runtime: unknown provenance → nothing to resume (no-session).
//   - any other runtime: a session this build cannot resume (e.g. a future codex session) →
//     unknown-runtime, so the CLI explains it rather than mislabel it "no session".
export type RuntimeResume =
  | { ok: true; runtime: string; sessionId: string }
  | { ok: false; reason: "no-session" | "unknown-runtime" };

export function resolveRuntimeResume(
  runtime: string | null,
  externalSession: string | null | undefined,
): RuntimeResume {
  if (runtime === RUNTIME_CLAUDE_CODE) {
    return isClaudeSessionId(externalSession)
      ? { ok: true, runtime, sessionId: externalSession }
      : { ok: false, reason: "no-session" };
  }
  if (runtime == null) return { ok: false, reason: "no-session" };
  return { ok: false, reason: "unknown-runtime" };
}

// The scheme + number that identifies a PR's worktree path/branch (#463). The head branch is the
// most direct source: a legacy `loophub/issue-<n>` branch means the worktree was provisioned
// before #463 and still lives at the issue-<n> path, so that convention is preserved for any
// branch matching it. Anything else — including the current `loophub/pr-<n>` convention and any
// off-convention (manually created) branch — resolves to the PR's own number: worktree/branch
// naming is PR-id-based going forward, so a PR must never fall back to its linked issue's number
// (that fallback pre-#463 is exactly what let two PRs on the same issue collide on one worktree).
export function resolveWorktreeIdentity(
  headRef: string | null,
  prNumber: number,
): WorktreeIdentity {
  const legacyIssue = issueNumberFromBranch(headRef);
  if (legacyIssue != null)
    return { scheme: "legacy-issue", number: legacyIssue };
  return { scheme: "pr", number: prNumber };
}
