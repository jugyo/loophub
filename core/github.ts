// #411: the gh/git seam for submitting a loophub PR to GitHub. Kept separate from
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

// Create a GitHub PR for `head` against `base`. Resolves the new PR's number+url via a
// follow-up `pr view` (authoritative), falling back to parsing the URL `gh pr create` prints.
export async function createPr(
  repoPath: string,
  input: { base: string; head: string; title: string; body: string },
): Promise<GhPr> {
  const created = await gh(repoPath, [
    "pr",
    "create",
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
  create: typeof createPr;
}

export const realGithubDeps: GithubDeps = {
  push: pushBranch,
  view: viewPr,
  create: createPr,
};

// #614: the GitHub identity of an issue, parsed from its web URL.
export interface GithubIssueRef {
  owner: string;
  repo: string;
  number: number;
}

export interface GithubIssueContent {
  number: number;
  title: string;
  body: string;
  url: string;
}

export interface GithubPullRef {
  owner: string;
  repo: string;
  number: number;
}

// Parse the recorded web URL into coordinates safe to use in `gh api` endpoint argv values. Keep
// the path exact: extra path components and non-github.com hosts are not a GitHub PR identity.
export function parseGithubPullUrl(url: string): GithubPullRef | null {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (
    !["github.com", "www.github.com"].includes(parsed.hostname.toLowerCase())
  ) {
    return null;
  }
  const match = parsed.pathname.match(
    /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/,
  );
  if (!match) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  return { owner: match[1], repo: match[2], number };
}

// Parse a GitHub issue URL into owner/repo/number, or null when it is not a well-formed github.com
// issue URL. Pure (no gh/network), so the service layer validates the input before spending a fetch,
// and it is unit-testable on its own. Host is pinned to github.com (the model is GitHub-only); the
// path must be exactly `/<owner>/<repo>/issues/<number>` (a `/pull/<n>` URL is intentionally rejected
// — importing a PR as an issue is out of scope). Query/fragment (e.g. `#issuecomment-123`) is ignored.
export function parseGithubIssueUrl(url: string): GithubIssueRef | null {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") return null;
  const m = u.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner: m[1], repo: m[2], number };
}

// Fetch a GitHub issue's number/title/body/url via the `gh` CLI. `--repo owner/repo <number>` is used
// (rather than passing the URL) so the coordinates the caller parsed are authoritative and no value is
// interpreted as a flag. `repoPath` is the cwd gh runs in (the destination repo's checkout) — matching
// the rest of this module; the explicit `--repo` overrides gh's cwd-based repo resolution regardless.
// Throws on any gh failure (auth/network/not-found) so the caller surfaces it rather than importing an
// empty issue.
export async function fetchGithubIssue(
  repoPath: string,
  ref: GithubIssueRef,
): Promise<GithubIssueContent> {
  const r = await gh(repoPath, [
    "issue",
    "view",
    String(ref.number),
    "--repo",
    `${ref.owner}/${ref.repo}`,
    "--json",
    "number,title,body,url",
  ]);
  if (r.code !== 0)
    throw new Error(
      `gh issue view failed: ${r.stderr.trim() || r.stdout.trim()}`,
    );
  let j: { number?: unknown; title?: unknown; body?: unknown; url?: unknown };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error(
      `gh issue view returned unparseable JSON: ${r.stdout.trim()}`,
    );
  }
  if (typeof j.number !== "number" || typeof j.title !== "string")
    throw new Error(
      `gh issue view returned unexpected JSON: ${r.stdout.trim()}`,
    );
  return {
    number: j.number,
    title: j.title,
    body: typeof j.body === "string" ? j.body : "",
    url: typeof j.url === "string" ? j.url : "",
  };
}

export interface GithubIssueDeps {
  fetchIssue: typeof fetchGithubIssue;
}

export const realGithubIssueDeps: GithubIssueDeps = {
  fetchIssue: fetchGithubIssue,
};

// #800: the GitHub-side merge status of a PR already exported via github_pulls.
export interface GhPrMergeStatus {
  merged: boolean;
  mergedAt: string | null;
  mergedByLogin: string | null;
}

// Fetch a GitHub PR's merge status by its URL (rather than branch or number+`--repo`) — the caller
// already has the absolute URL recorded in github_pulls, and passing it straight to `gh pr view`
// resolves owner/repo/number from it directly, so `repoPath`'s own git remote need not match.
// Throws on any gh failure (auth/network/deleted PR) so a sync sweep can skip this row for the
// current tick rather than treating a transient failure as "not merged".
export async function fetchGithubPrMergeStatus(
  repoPath: string,
  url: string,
): Promise<GhPrMergeStatus> {
  const r = await gh(repoPath, [
    "pr",
    "view",
    url,
    "--json",
    "state,mergedAt,mergedBy",
  ]);
  if (r.code !== 0)
    throw new Error(`gh pr view failed: ${r.stderr.trim() || r.stdout.trim()}`);
  let j: { state?: unknown; mergedAt?: unknown; mergedBy?: unknown };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error(`gh pr view returned unparseable JSON: ${r.stdout.trim()}`);
  }
  const state = typeof j.state === "string" ? j.state : "";
  const mergedBy = j.mergedBy as { login?: unknown } | null | undefined;
  return {
    merged: state.toUpperCase() === "MERGED",
    mergedAt: typeof j.mergedAt === "string" ? j.mergedAt : null,
    mergedByLogin:
      mergedBy && typeof mergedBy.login === "string" ? mergedBy.login : null,
  };
}

export interface GithubMergeStatusDeps {
  fetchMergeStatus: typeof fetchGithubPrMergeStatus;
}

export const realGithubMergeStatusDeps: GithubMergeStatusDeps = {
  fetchMergeStatus: fetchGithubPrMergeStatus,
};

export type GithubPrFeedbackKind =
  | "issue_comment"
  | "review"
  | "review_comment";

export interface GithubPrFeedback {
  kind: GithubPrFeedbackKind;
  id: number;
  body: string;
  updatedAt: string;
}

export type GithubApiRunner = (
  repoPath: string,
  endpoint: string,
) => Promise<string>;

async function runGithubApi(
  repoPath: string,
  endpoint: string,
): Promise<string> {
  const result = await gh(repoPath, ["api", "--paginate", "--slurp", endpoint]);
  if (result.code !== 0) {
    throw new Error(
      `gh api failed for ${endpoint}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
  return result.stdout;
}

function paginatedItems(stdout: string, endpoint: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`gh api returned unparseable JSON for ${endpoint}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`gh api returned unexpected JSON for ${endpoint}`);
  }
  // `gh api --paginate --slurp` wraps every response page in an outer array. Accept a flat array
  // as well for injected runners and older gh versions that ignore --slurp on a single page.
  return parsed.every(Array.isArray) ? parsed.flat() : parsed;
}

function normalizeFeedback(
  kind: GithubPrFeedbackKind,
  items: unknown[],
): GithubPrFeedback[] {
  const normalized: GithubPrFeedback[] = [];
  for (const value of items) {
    if (!value || typeof value !== "object") continue;
    const item = value as Record<string, unknown>;
    if (!Number.isSafeInteger(item.id) || (item.id as number) < 1) continue;
    if (typeof item.body !== "string") continue;
    // GitHub includes draft reviews in this endpoint with state=PENDING and no submitted_at. Do not
    // observe their bodies yet: otherwise the later submitted review (same id/body) would already
    // be deduped. Conversation and inline comments do not have this draft lifecycle.
    if (
      kind === "review" &&
      ((typeof item.state === "string" &&
        item.state.toUpperCase() === "PENDING") ||
        typeof item.submitted_at !== "string" ||
        item.submitted_at.trim() === "")
    ) {
      continue;
    }
    const timestamp = [
      item.updated_at,
      item.submitted_at,
      item.created_at,
    ].find((candidate): candidate is string => typeof candidate === "string");
    normalized.push({
      kind,
      id: item.id as number,
      body: item.body,
      updatedAt: timestamp ?? "",
    });
  }
  return normalized;
}

// Fetch the three GitHub feedback surfaces independently, while exposing only normalized feedback
// to the sync. The body is used solely for hashing and never becomes part of an event payload.
export async function fetchGithubPrFeedback(
  repoPath: string,
  url: string,
  api: GithubApiRunner = runGithubApi,
): Promise<GithubPrFeedback[]> {
  const ref = parseGithubPullUrl(url);
  if (!ref) throw new Error(`invalid GitHub PR URL: ${url}`);
  const root = `repos/${ref.owner}/${ref.repo}`;
  const endpoints = [
    `${root}/issues/${ref.number}/comments`,
    `${root}/pulls/${ref.number}/reviews`,
    `${root}/pulls/${ref.number}/comments`,
  ] as const;
  const outputs = await Promise.all(
    endpoints.map((endpoint) => api(repoPath, endpoint)),
  );
  return [
    ...normalizeFeedback(
      "issue_comment",
      paginatedItems(outputs[0], endpoints[0]),
    ),
    ...normalizeFeedback("review", paginatedItems(outputs[1], endpoints[1])),
    ...normalizeFeedback(
      "review_comment",
      paginatedItems(outputs[2], endpoints[2]),
    ),
  ];
}

export interface GithubFeedbackDeps {
  fetchFeedback: typeof fetchGithubPrFeedback;
}

export const realGithubFeedbackDeps: GithubFeedbackDeps = {
  fetchFeedback: fetchGithubPrFeedback,
};

// #850: the GitHub-side status of a PR already exported via github_pulls, for the PR-detail right
// sidebar. Normalized to lowercase enums here (gh returns uppercase) so the wire/UI never re-derive
// gh's raw shape. `merged` is redundant with state==="merged" but kept explicit for the UI. `comments`
// counts conversation (issue) comments only; `reviews` counts submitted reviews — kept as two distinct
// figures so the UI can label each and never conflate the two counts (#850 AC).
export interface GhPrStatus {
  state: "open" | "closed" | "merged";
  merged: boolean;
  mergeable: "mergeable" | "conflicting" | "unknown";
  reviewDecision: "approved" | "changes_requested" | "review_required" | null;
  checks: "success" | "failure" | "pending" | "none";
  comments: number;
  reviews: number;
  updatedAt: string | null;
}

// Classify one statusCheckRollup entry. gh returns two shapes: CheckRun (has `status`+`conclusion`)
// and StatusContext (has `state`). A CheckRun still running (status != COMPLETED) is pending; once
// completed, only SUCCESS/NEUTRAL/SKIPPED count as passing. A StatusContext maps SUCCESS→pass,
// PENDING/EXPECTED→pending, everything else (ERROR/FAILURE)→fail.
function classifyCheck(item: {
  status?: unknown;
  conclusion?: unknown;
  state?: unknown;
}): "pass" | "fail" | "pending" {
  if (typeof item.status === "string") {
    if (item.status.toUpperCase() !== "COMPLETED") return "pending";
    const c = (
      typeof item.conclusion === "string" ? item.conclusion : ""
    ).toUpperCase();
    return c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED"
      ? "pass"
      : "fail";
  }
  const s = (typeof item.state === "string" ? item.state : "").toUpperCase();
  if (s === "SUCCESS") return "pass";
  if (s === "PENDING" || s === "EXPECTED") return "pending";
  return "fail";
}

// Roll a statusCheckRollup array up into a single overall verdict: any failing check wins (failure),
// else any pending check (pending), else success; an empty rollup means no checks are configured.
function rollupChecks(items: unknown): GhPrStatus["checks"] {
  if (!Array.isArray(items) || items.length === 0) return "none";
  let pending = false;
  for (const it of items) {
    const c = classifyCheck(it as Record<string, unknown>);
    if (c === "fail") return "failure";
    if (c === "pending") pending = true;
  }
  return pending ? "pending" : "success";
}

function lowerEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
): T | null {
  if (typeof v !== "string") return null;
  const lower = v.toLowerCase() as T;
  return allowed.includes(lower) ? lower : null;
}

// Fetch a GitHub PR's status by its URL (owner/repo/number resolve from the URL, so `repoPath`'s own
// remote need not match — mirrors fetchGithubPrMergeStatus). Throws on any gh failure so the caller
// can fall back to a cached value or surface the error, rather than reporting a transient failure as
// a real status. `comments`/`reviews` request the full arrays (gh has no count-only projection); only
// their lengths are kept.
export async function fetchGithubPrStatus(
  repoPath: string,
  url: string,
): Promise<GhPrStatus> {
  const r = await gh(repoPath, [
    "pr",
    "view",
    "--json",
    "state,mergeable,reviewDecision,statusCheckRollup,comments,reviews,updatedAt",
    // Pass the URL after `--` so it can never be mistaken for a flag, matching viewPr — the value is
    // already GitHub-validated at every write path, so this is defense-in-depth against that ever
    // being loosened.
    "--",
    url,
  ]);
  if (r.code !== 0)
    throw new Error(`gh pr view failed: ${r.stderr.trim() || r.stdout.trim()}`);
  let j: {
    state?: unknown;
    mergeable?: unknown;
    reviewDecision?: unknown;
    statusCheckRollup?: unknown;
    comments?: unknown;
    reviews?: unknown;
    updatedAt?: unknown;
  };
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new Error(`gh pr view returned unparseable JSON: ${r.stdout.trim()}`);
  }
  const state =
    lowerEnum(j.state, ["open", "closed", "merged"] as const) ?? "open";
  return {
    state,
    merged: state === "merged",
    mergeable:
      lowerEnum(j.mergeable, [
        "mergeable",
        "conflicting",
        "unknown",
      ] as const) ?? "unknown",
    reviewDecision: lowerEnum(j.reviewDecision, [
      "approved",
      "changes_requested",
      "review_required",
    ] as const),
    checks: rollupChecks(j.statusCheckRollup),
    comments: Array.isArray(j.comments) ? j.comments.length : 0,
    reviews: Array.isArray(j.reviews) ? j.reviews.length : 0,
    updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
  };
}

export interface GithubPrStatusDeps {
  fetchStatus: typeof fetchGithubPrStatus;
}

export const realGithubPrStatusDeps: GithubPrStatusDeps = {
  fetchStatus: fetchGithubPrStatus,
};
