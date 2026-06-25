// Pure decision logic for `lh resume <PR id>` (cli/index.ts → core/service.ts resume.resolve).
// Kept free of git/DB side effects so the "can this PR's session be resumed, and does its
// worktree need restoring?" judgment is unit-testable in isolation; the service layer feeds it
// the resolved session id and the on-disk worktree/branch facts.
import { issueNumberFromBranch } from "./worktree-prune.ts";

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

// The agent label `lh dev` registers its session under (cli/index.ts `sessions.register`). A
// resumable Claude session is specifically one `lh dev` launched: it registers under this agent and
// stores the exact UUID it handed to `claude --session-id`. Another agent's external_session (e.g.
// an impl-bot's runtime id) is that agent's own id, not a Claude session id, so resume must accept
// only sessions registered under this agent — UUID shape alone does not prove Claude provenance.
export const LH_DEV_SESSION_AGENT = "lh-dev";

// A Claude session id is a UUID (`claude --session-id` requires one; `lh dev` stores the exact
// UUID it generates). `lh resume` reads a *stored* id and feeds it to `claude --resume <id>`, so
// validate the shape before it reaches argv: claude's `-r, --resume [value]` takes an OPTIONAL
// value, meaning a token starting with `-` would be misparsed as a separate flag rather than the
// resume target (argv/flag injection). Anything not UUID-shaped is not a resumable Claude session.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isClaudeSessionId(id: string | null | undefined): id is string {
  return typeof id === "string" && UUID_RE.test(id);
}

// The issue number that identifies a PR's worktree path/branch. `lh dev <n>` names the worktree
// after the issue and opens the PR on branch `loophub/issue-<n>`, so the head branch is the most
// direct source; fall back to the PR's linked issue, then the PR's own number (a PR worked
// directly via `lh dev <pr>` whose branch is off-convention).
export function resumeWorktreeIssue(
  headRef: string | null,
  linkedIssueNumber: number | null,
  prNumber: number,
): number {
  return issueNumberFromBranch(headRef) ?? linkedIssueNumber ?? prNumber;
}
