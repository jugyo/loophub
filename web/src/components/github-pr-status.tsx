// The GitHub PR view of the PR-detail right pane (#850). Shown only when the loophub PR has a linked
// GitHub PR (github_pull). Top to bottom: the link out to GitHub with its Push / Force push / Unlink
// menu, the merge status with its blockers and Ready action, the CI checks of the latest
// head, and the conversation. Everything displayed comes from what lh-worker's sweeps stored, so
// opening the view never waits on `gh`; the one exception is a check's log, fetched when it is opened.
// A write goes to GitHub straight away and shows up here once the next sweep has seen it.
//
// The "not linked" state renders nothing at all, so the page can hand the section every PR and let
// it decide (like WorkflowRunSection).

import {
  ArrowDown,
  ArrowUp,
  EllipsisVertical,
  ExternalLink,
  Github,
  Loader2,
  RotateCw,
  Unlink,
  UploadCloud,
} from "lucide-react";
import {
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  GithubCheckRun,
  GithubConversationEntry,
  GithubPrStatus,
  GithubPull,
  PullRequest,
} from "@/api/types";
import { GithubPrConversation } from "@/components/github-pr-conversation";
import { Markdown } from "@/components/markdown";
import { PullPaneHead } from "@/components/pull-pane-head";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BadgeTone } from "@/lib/badges";
import { errorMessage } from "@/lib/error-message";
import { formatDuration, relativeTime } from "@/lib/time";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import {
  useGithubCheckLog,
  useGithubConversation,
  useGithubPullAction,
  useGithubSyncJob,
  usePushGithubPull,
  useSyncGithubPull,
  useUnlinkGithubPull,
} from "@/queries/pulls";

const STATE: Record<
  GithubPrStatus["state"],
  { tone: BadgeTone; label: string }
> = {
  open: { tone: "open", label: "Open" },
  closed: { tone: "closed", label: "Closed" },
  merged: { tone: "merged", label: "Merged" },
};

const REVIEW: Record<
  NonNullable<GithubPrStatus["review_decision"]>,
  { tone: BadgeTone; label: string }
> = {
  approved: { tone: "review-passed", label: "Approved" },
  changes_requested: { tone: "review-changes", label: "Changes requested" },
  review_required: { tone: "review-rereview", label: "Review required" },
};

const CHECKS: Record<
  GithubPrStatus["checks"],
  { tone: BadgeTone; label: string } | null
> = {
  success: { tone: "review-passed", label: "Passed" },
  failure: { tone: "conflict", label: "Failing" },
  pending: { tone: "working", label: "Pending" },
  // No checks configured on the GitHub PR — the row is hidden rather than showing a meaningless badge.
  none: null,
};

const MERGEABLE: Record<
  GithubPrStatus["mergeable"],
  { tone: BadgeTone; label: string } | null
> = {
  mergeable: { tone: "mergeable", label: "No conflicts" },
  conflicting: { tone: "conflict", label: "Conflicts" },
  // Unknown (e.g. a merged/closed PR, or GitHub still computing) — hidden to keep the panel compact.
  unknown: null,
};

/**
 * The GitHub PR link's text: the stored URL minus its scheme and host, e.g. `me/proj/pull/42`. Kept
 * as a plain strip rather than a parse into owner/repo/number, so a URL that doesn't have the shape
 * we expect still reads as itself instead of throwing or being reduced to a bare number.
 */
function githubPrPath(url: string) {
  return url.replace(/^https?:\/\/[^/]+\//, "");
}

/** One `label + badge` row; renders nothing when the badge is absent (keeps the panel compact). */
function StatusRow({
  label,
  badge,
}: {
  label: string;
  badge: { tone: BadgeTone; label: string } | null;
}) {
  if (!badge) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}

function CommitSyncCounts({
  unpushed,
  unpulled,
}: {
  unpushed: number | null;
  unpulled: number | null;
}) {
  const ahead = unpushed ?? "—";
  const behind = unpulled ?? "—";
  return (
    <span className="flex items-center gap-2 text-xs tabular-nums">
      <span
        role="group"
        aria-label={`Unpushed commits: ${ahead}`}
        title={`Unpushed commits: ${ahead}`}
        className="flex items-center gap-0.5"
      >
        <ArrowUp className="size-3.5" aria-hidden="true" />
        {ahead}
      </span>
      <span
        role="group"
        aria-label={`Unpulled commits: ${behind}`}
        title={`Unpulled commits: ${behind}`}
        className="flex items-center gap-0.5"
      >
        <ArrowDown className="size-3.5" aria-hidden="true" />
        {behind}
      </span>
    </span>
  );
}

const REVIEWER: Record<
  GithubPrStatus["reviewers"][number]["state"],
  { tone: BadgeTone; label: string }
> = {
  approved: { tone: "review-passed", label: "Approved" },
  changes_requested: { tone: "review-changes", label: "Changes requested" },
  commented: { tone: "unknown", label: "Commented" },
  dismissed: { tone: "unknown", label: "Dismissed" },
  pending: { tone: "review-rereview", label: "Pending" },
};

const CHECK_STATE: Record<
  GithubCheckRun["state"],
  { tone: BadgeTone; label: string }
> = {
  success: { tone: "review-passed", label: "Passed" },
  failure: { tone: "conflict", label: "Failed" },
  pending: { tone: "working", label: "Running" },
};

const AFTER_SYNC = "Sent to GitHub. It shows here after the next sync.";

function requiredChecksBadge(
  runs: GithubCheckRun[],
): { tone: BadgeTone; label: string } | null {
  const required = runs.filter((run) => run.required);
  if (required.length === 0) return null;
  const failing = required.filter((run) => run.state === "failure").length;
  if (failing > 0) return { tone: "conflict", label: `${failing} failing` };
  const pending = required.filter((run) => run.state === "pending").length;
  if (pending > 0) return { tone: "working", label: `${pending} running` };
  return { tone: "review-passed", label: "All passed" };
}

function checkDuration(run: GithubCheckRun): string {
  if (!run.started_at || !run.completed_at) return "—";
  const ms = Date.parse(run.completed_at) - Date.parse(run.started_at);
  return Number.isNaN(ms) ? "—" : formatDuration(Math.max(0, ms / 1000));
}

function unresolvedThreadIds(entries: GithubConversationEntry[]): number[] {
  return entries
    .flatMap((entry) =>
      entry.kind === "thread"
        ? [entry.thread]
        : entry.kind === "review"
          ? entry.threads
          : [],
    )
    .filter((thread) => thread.resolved === false)
    .map((thread) => thread.id);
}

// The GitHub PR's title and body. A body taller than about ten lines starts clipped to them, with a
// toggle to read the rest; only a body that actually overflows gets the toggle. Rendered like the
// conversation bodies: GitHub text keeps only http(s) links and no hub `#N` references.
function GithubPrDescription({
  title,
  body,
}: {
  title: string | null;
  body: string;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  // Measured while clipped; once expanded the box no longer overflows, so the result is kept. The
  // pane can mount hidden (zero height), so the box is measured again whenever it resizes.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body, expanded]);
  const hasBody = body.trim() !== "";
  if (!title && !hasBody) return null;
  return (
    <div
      data-debug-component="GithubPrDescription"
      className="flex min-w-0 flex-col gap-1.5"
    >
      {title ? (
        <h3 className="text-base font-semibold break-words">{title}</h3>
      ) : null}
      {hasBody ? (
        <>
          <div
            ref={bodyRef}
            className={`min-w-0 text-sm ${expanded ? "" : "max-h-[10lh] overflow-hidden"}`}
          >
            <Markdown
              breaks
              httpLinksOnly
              className="min-w-0 text-sm break-words [&_code]:break-words [&_pre]:max-w-full [&_pre]:overflow-x-auto"
            >
              {body}
            </Markdown>
          </div>
          {overflows ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-fit px-2 text-xs"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Show less" : "Read more"}
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function PaneBlock({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-t pt-3">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
      {children}
    </div>
  );
}

export function GithubPrStatusSection({
  owner,
  repo,
  pull,
  status,
  isLoading,
  agentRunning = false,
}: {
  // The loophub PR the section belongs to: its coordinates address the section's mutations (#2384,
  // #2516), its link is what the section shows, and the push action reads its state/head to decide
  // whether there is anything to push.
  owner: string;
  repo: string;
  pull: PullRequest;
  // null: the sweep has not seen this PR yet. undefined and not loading: the read failed.
  status: GithubPrStatus | null | undefined;
  isLoading: boolean;
  agentRunning?: boolean;
}) {
  // The linked GitHub PR (#2035): the body's first row is the single link out to GitHub, so the
  // PR-detail action row doesn't need a separate "View PR on GitHub" button. Without a link there is
  // no status to read and nothing to push, so the whole section is absent.
  const githubPull = pull.github_pull;
  const conversation = useGithubConversation(
    owner,
    repo,
    pull.number,
    !!githubPull,
  );
  const [selectedThreads, setSelectedThreads] = useState<Set<number>>(
    new Set(),
  );
  const [selectedJobs, setSelectedJobs] = useState<Set<number>>(new Set());
  const unresolved = useMemo(
    () => unresolvedThreadIds(conversation.data?.entries ?? []),
    [conversation.data],
  );
  if (!githubPull) return null;

  const pullOpen = pull.state === "open" && !pull.merged;
  // A GitHub PR closed or merged on GitHub takes no more writes either.
  const canWrite = pullOpen && (status?.state ?? "open") === "open";
  const failedJobs = (status?.check_runs ?? []).flatMap((run) =>
    run.state === "failure" && run.job_id ? [run.job_id] : [],
  );
  const toggle = (setSelected: typeof setSelectedThreads) => (id: number) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  return (
    <section
      data-debug-component="GithubPrStatusSection"
      className="flex h-full min-h-0 min-w-0 flex-col"
    >
      <PullPaneHead title="GitHub PR">
        <GithubSyncButton owner={owner} repo={repo} number={pull.number} />
      </PullPaneHead>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto p-4">
        {/* The route out to GitHub (#2091). Outside the status branches below because it is the PR
            detail's only link to the GitHub PR, so it must stay reachable while the status is loading
            or failed; the menu too, since unlinking is what you reach for when the status fails.
            The text is the URL's own `owner/repo/pull/N` path rather than a bare `#N`: it says which
            GitHub repo the PR lives in, which a fork or a mirror makes non-obvious. */}
        <div className="flex min-w-0 items-center justify-between gap-2">
          <a
            href={githubPull.url}
            target="_blank"
            rel="noopener noreferrer"
            title={`GitHub PR #${githubPull.number}`}
            className="inline-flex min-w-0 items-center gap-1.5 text-sm hover:underline"
          >
            <Github className="size-4 shrink-0" />
            <span className="min-w-0 break-all">
              {githubPrPath(githubPull.url)}
            </span>
            <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
          </a>
          {pullOpen ? (
            <GithubPrMenu
              owner={owner}
              repo={repo}
              pull={pull}
              githubPull={githubPull}
            />
          ) : null}
        </div>
        {!pullOpen ? (
          <p className="rounded-md border bg-muted/40 p-2 text-xs text-muted-foreground">
            This PR is {pull.merged ? "merged" : "closed"}, so GitHub data is no
            longer refreshed automatically
            {status ? ` (synced ${relativeTime(status.synced_at)})` : ""}. Use
            the sync button to refresh it.
          </p>
        ) : null}
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading GitHub status…
          </div>
        ) : status === null ? (
          <p className="text-sm text-muted-foreground">
            No GitHub status has been synced for this PR yet.
          </p>
        ) : /* Prefer the last-loaded status over the error box: React Query keeps `data` on a failed
              background refetch, so a transient blip (server restart, focus refetch) shouldn't blank a
              good panel. The error box shows only when there is no status to fall back to. */
        status ? (
          <>
            <GithubPrDescription title={status.title} body={status.body} />
            <MergeStatus
              owner={owner}
              repo={repo}
              number={pull.number}
              status={status}
              unresolvedThreads={conversation.data?.unresolved_threads ?? null}
              canWrite={canWrite}
            />
            <ChecksBlock
              owner={owner}
              repo={repo}
              number={pull.number}
              runs={status.check_runs}
              canWrite={canWrite}
              agentRunning={agentRunning}
              selected={selectedJobs}
              onToggle={toggle(setSelectedJobs)}
            />
          </>
        ) : (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
            Failed to load GitHub status.
          </div>
        )}
        <PaneBlock title="Conversation">
          <GithubPrConversation
            owner={owner}
            repo={repo}
            number={pull.number}
            query={conversation}
            canWrite={canWrite}
            agentRunning={agentRunning}
            selected={selectedThreads}
            onToggle={toggle(setSelectedThreads)}
          />
        </PaneBlock>
      </div>
      {canWrite && unresolved.length + failedJobs.length > 0 ? (
        <AskAgentBar
          owner={owner}
          repo={repo}
          number={pull.number}
          agentRunning={agentRunning}
          threadIds={unresolved.filter((id) => selectedThreads.has(id))}
          jobIds={failedJobs.filter((id) => selectedJobs.has(id))}
          onSent={() => {
            setSelectedThreads(new Set());
            setSelectedJobs(new Set());
          }}
        />
      ) : null}
    </section>
  );
}

// Sync this PR with GitHub now instead of waiting for the periodic sweep. The request only queues
// a job; the synced data arrives through the usual events, and the job's own state drives the
// spinner and the error.
function GithubSyncButton({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const job = useGithubSyncJob(owner, repo, number, true).data;
  const sync = useSyncGithubPull(owner, repo, number);
  const syncing =
    sync.isPending || job?.status === "queued" || job?.status === "running";
  const error = sync.isError
    ? errorMessage(sync.error)
    : job?.status === "failed"
      ? job.error
      : null;
  return (
    <div className="ml-auto flex min-w-0 items-center gap-2">
      {error && !syncing ? (
        <span
          role="alert"
          title={error}
          className="min-w-0 truncate text-xs text-destructive"
        >
          Sync failed: {error}
        </span>
      ) : null}
      <Button
        variant="ghost"
        size="icon"
        type="button"
        className="h-7 w-7 shrink-0"
        aria-label={syncing ? "Syncing with GitHub" : "Sync with GitHub"}
        title={syncing ? "Syncing with GitHub…" : "Sync with GitHub"}
        disabled={syncing}
        onClick={() => sync.mutate()}
      >
        <RotateCw className={`size-4${syncing ? " animate-spin" : ""}`} />
      </Button>
    </div>
  );
}

function MergeStatus({
  owner,
  repo,
  number,
  status,
  unresolvedThreads,
  canWrite,
}: {
  owner: string;
  repo: string;
  number: number;
  status: GithubPrStatus;
  unresolvedThreads: number | null;
  canWrite: boolean;
}) {
  const { showError, showInfo } = useToast();
  const action = useGithubPullAction(owner, repo, number);
  const run = (method: "pulls/markGithubPullReady", fallback: string) =>
    action.mutate(
      { method },
      {
        onSuccess: () => showInfo(AFTER_SYNC),
        onError: (e) => showError(errorMessage(e, fallback)),
      },
    );
  return (
    <PaneBlock title="Merge status">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={STATE[status.state].tone}>
            {STATE[status.state].label}
          </Badge>
          {status.is_draft ? <Badge tone="unknown">Draft</Badge> : null}
        </div>
        <StatusRow
          label="Review"
          badge={
            status.review_decision
              ? REVIEW[status.review_decision]
              : { tone: "unknown", label: "None" }
          }
        />
        {status.reviewers.map((reviewer) => (
          <StatusRow
            key={reviewer.login}
            label={reviewer.login}
            badge={REVIEWER[reviewer.state]}
          />
        ))}
        {unresolvedThreads !== null ? (
          <StatusRow
            label="Unresolved threads"
            badge={{
              tone: unresolvedThreads > 0 ? "conflict" : "review-passed",
              label: String(unresolvedThreads),
            }}
          />
        ) : null}
        <StatusRow
          label="Required checks"
          badge={requiredChecksBadge(status.check_runs)}
        />
        <StatusRow label="Checks" badge={CHECKS[status.checks]} />
        <StatusRow label="Mergeable" badge={MERGEABLE[status.mergeable]} />
        {canWrite ? (
          <div className="flex flex-wrap gap-2">
            {status.is_draft ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={action.isPending}
                onClick={() =>
                  run("pulls/markGithubPullReady", "Marking as Ready failed")
                }
              >
                Ready for review
              </Button>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-col gap-2 border-t pt-2">
          <CommitSyncCounts
            unpushed={status.unpushed_commits}
            unpulled={status.unpulled_commits}
          />
        </div>
        {/* Two distinct counts, labeled so neither is mistaken for the other (#850 AC): conversation
            comments vs submitted reviews. */}
        <p className="text-xs text-muted-foreground">
          {status.comments} comment{status.comments === 1 ? "" : "s"} ·{" "}
          {status.reviews} review{status.reviews === 1 ? "" : "s"}
        </p>
        <p className="text-xs text-muted-foreground">
          {status.updated_at
            ? `Updated ${relativeTime(status.updated_at)} · `
            : ""}
          synced {relativeTime(status.synced_at)}
        </p>
      </div>
    </PaneBlock>
  );
}

function ChecksBlock({
  owner,
  repo,
  number,
  runs,
  canWrite,
  agentRunning,
  selected,
  onToggle,
}: {
  owner: string;
  repo: string;
  number: number;
  runs: GithubCheckRun[];
  canWrite: boolean;
  agentRunning: boolean;
  selected: Set<number>;
  onToggle: (jobId: number) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <PaneBlock title="CI">
      <ul className="flex min-w-0 flex-col gap-2">
        {runs.map((run) => (
          <CheckRow
            key={`${run.workflow}/${run.name}/${run.job_id}`}
            owner={owner}
            repo={repo}
            number={number}
            run={run}
            canWrite={canWrite}
            agentRunning={agentRunning}
            selected={run.job_id !== null && selected.has(run.job_id)}
            onToggle={onToggle}
          />
        ))}
      </ul>
    </PaneBlock>
  );
}

function CheckRow({
  owner,
  repo,
  number,
  run,
  canWrite,
  agentRunning,
  selected,
  onToggle,
}: {
  owner: string;
  repo: string;
  number: number;
  run: GithubCheckRun;
  canWrite: boolean;
  agentRunning: boolean;
  selected: boolean;
  onToggle: (jobId: number) => void;
}) {
  const [logOpen, setLogOpen] = useState(false);
  // A re-run is a new job with a new id, so the row keeps saying so until the sweep replaces it.
  const [rerunSent, setRerunSent] = useState(false);
  const { showError, showInfo } = useToast();
  const action = useGithubPullAction(owner, repo, number);
  const jobId = run.job_id;
  const failed = run.state === "failure" && jobId !== null;
  const name = run.workflow ? `${run.workflow} / ${run.name}` : run.name;
  return (
    <li className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2">
        {failed && canWrite ? (
          <input
            type="checkbox"
            aria-label={`Select ${name} for the agent`}
            title={agentRunning ? undefined : NO_AGENT_REASON}
            disabled={!agentRunning}
            checked={selected}
            onChange={() => onToggle(jobId)}
          />
        ) : null}
        <Badge tone={CHECK_STATE[run.state].tone}>
          {CHECK_STATE[run.state].label}
        </Badge>
        {run.url ? (
          <a
            href={run.url}
            target="_blank"
            rel="noopener noreferrer"
            className="min-w-0 flex-1 truncate text-xs hover:underline"
            title={name}
          >
            {name}
          </a>
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs" title={name}>
            {name}
          </span>
        )}
        {run.required ? (
          <span className="shrink-0 text-xs text-muted-foreground">
            Required
          </span>
        ) : null}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {checkDuration(run)}
        </span>
      </div>
      {failed ? (
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            aria-expanded={logOpen}
            onClick={() => setLogOpen((open) => !open)}
          >
            {logOpen ? "Hide log" : "Show log"}
          </Button>
          {canWrite ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              disabled={action.isPending || rerunSent}
              onClick={() =>
                action.mutate(
                  {
                    method: "pulls/rerunGithubCheck",
                    params: { job_id: jobId },
                  },
                  {
                    onSuccess: () => {
                      setRerunSent(true);
                      showInfo(AFTER_SYNC);
                    },
                    onError: (e) => showError(errorMessage(e, "Re-run failed")),
                  },
                )
              }
            >
              <RotateCw className="size-3" />
              {rerunSent ? "Re-run requested" : "Re-run"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {failed && logOpen ? (
        <CheckLog owner={owner} repo={repo} number={number} jobId={jobId} />
      ) : null}
    </li>
  );
}

function CheckLog({
  owner,
  repo,
  number,
  jobId,
}: {
  owner: string;
  repo: string;
  number: number;
  jobId: number;
}) {
  const log = useGithubCheckLog(owner, repo, number, jobId, true);
  if (log.isLoading) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3 animate-spin" /> Loading log…
      </div>
    );
  }
  if (log.error) {
    return (
      <p className="text-xs text-destructive">
        {errorMessage(log.error, "Failed to load the log")}
      </p>
    );
  }
  return (
    <pre className="max-h-80 overflow-y-auto rounded-md bg-muted p-2 text-xs break-words whitespace-pre-wrap">
      {log.data?.excerpt || "This job has no failed-step log."}
    </pre>
  );
}

const NO_AGENT_REASON =
  "No agent is running on this PR, so nothing would act on the request.";

function AskAgentBar({
  owner,
  repo,
  number,
  agentRunning,
  threadIds,
  jobIds,
  onSent,
}: {
  owner: string;
  repo: string;
  number: number;
  agentRunning: boolean;
  threadIds: number[];
  jobIds: number[];
  onSent: () => void;
}) {
  const { showError, showInfo } = useToast();
  const action = useGithubPullAction(owner, repo, number);
  const count = threadIds.length + jobIds.length;
  return (
    <div className="flex shrink-0 items-center gap-2 border-t p-3">
      <Button
        size="sm"
        disabled={!agentRunning || count === 0 || action.isPending}
        onClick={() =>
          action.mutate(
            {
              method: "pulls/requestGithubFixes",
              params: { thread_ids: threadIds, job_ids: jobIds },
            },
            {
              onSuccess: () => {
                onSent();
                showInfo("Asked the agent to fix the selected items.");
              },
              onError: (e) =>
                showError(errorMessage(e, "Asking the agent failed")),
            },
          )
        }
      >
        Ask agent to fix{count > 0 ? ` (${count})` : ""}
      </Button>
      <p className="min-w-0 text-xs text-muted-foreground">
        {agentRunning
          ? "Select unresolved threads and failed checks."
          : NO_AGENT_REASON}
      </p>
    </div>
  );
}

/**
 * The section's write menu (#2516): push the PR's local head to the linked GitHub PR's branch (#848),
 * force-push a rewritten head (#1861), and drop the link (#2384). `isPending` keeps a push from
 * firing twice, and a failed push surfaces as a toast — the mutation has no dialog of its own.
 */
function GithubPrMenu({
  owner,
  repo,
  pull,
  githubPull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  githubPull: GithubPull;
}) {
  const { showError } = useToast();
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const pushChanges = usePushGithubPull(owner, repo, pull.number);
  const push = (force: boolean) =>
    pushChanges.mutate(force, {
      onError: (e) =>
        showError(
          errorMessage(
            e,
            force ? "Force push to GitHub failed" : "Push to GitHub failed",
          ),
        ),
    });

  // Unpushed local changes exist when we know what was last pushed (pushed_sha) and the PR's head
  // has moved past it. A null pushed_sha (e.g. an externally-attached PR never pushed from here)
  // reads as "nothing known to be unpushed". The menu only renders for an open, unmerged PR.
  const hasUnpushedChanges =
    !!githubPull.branch &&
    !!githubPull.pushed_sha &&
    !!pull.head.sha &&
    pull.head.sha !== githubPull.pushed_sha;
  const canPush = hasUnpushedChanges && !pushChanges.isPending;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0 px-2"
            aria-label="GitHub PR actions"
            title="GitHub PR actions"
          >
            {pushChanges.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <EllipsisVertical className="size-4" />
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!canPush}
            title={
              hasUnpushedChanges
                ? `Push local changes to the GitHub PR branch (${githubPull.branch})`
                : "No local changes to push to GitHub"
            }
            onSelect={() => push(false)}
          >
            <UploadCloud className="size-4" />
            Push to GitHub
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!canPush}
            title={`Force-push the head to the GitHub PR branch (${githubPull.branch}) with --force-with-lease, for a head rewritten by rebase or amend`}
            onSelect={() => push(true)}
          >
            <UploadCloud className="size-4" />
            Force push to GitHub
          </DropdownMenuItem>
          <DropdownMenuItem
            title="Remove this PR's link to the GitHub PR (the GitHub PR itself is not changed)"
            onSelect={() => setConfirmingUnlink(true)}
          >
            <Unlink className="size-4" />
            Unlink GitHub PR
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmingUnlink ? (
        <UnlinkGithubPrDialog
          owner={owner}
          repo={repo}
          number={pull.number}
          githubPull={githubPull}
          onClose={() => setConfirmingUnlink(false)}
        />
      ) : null}
    </>
  );
}

/**
 * Unlink confirmation (#2384): drops the LoopHub-side link so a wrong link can be corrected or a
 * GitHub PR created again — the PR-detail action row returns to "Create PR on GitHub" once
 * `github_pull` is null. Destructive enough to confirm first, and the confirmation says what is and
 * is not affected, since "unlink" could otherwise be read as closing the GitHub PR. The dialog
 * follows the PR archive confirmation (pull-debug-menu.tsx): backdrop/Escape dismissal gated on the
 * in-flight request, and the mutation error shown in the dialog rather than a toast, so the failure
 * lands next to the action that caused it.
 */
function UnlinkGithubPrDialog({
  owner,
  repo,
  number,
  githubPull,
  onClose,
}: {
  owner: string;
  repo: string;
  number: number;
  githubPull: GithubPull;
  onClose: () => void;
}) {
  const unlink = useUnlinkGithubPull(owner, repo, number);
  const backdropDismiss = useBackdropDismiss(() => {
    if (!unlink.isPending) onClose();
  });

  // Escape dismisses the dialog, under the same in-flight guard as the buttons and the backdrop.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !unlink.isPending) onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, unlink.isPending]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
      {...backdropDismiss}
    >
      <div
        data-debug-component="UnlinkGithubPrDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Unlink GitHub PR #${githubPull.number}?`}
        className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          Unlink GitHub PR #{githubPull.number}?
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          This removes only this PR's link to {githubPrPath(githubPull.url)} in
          LoopHub. The pull request on GitHub is not closed or changed.
          Afterwards you can create a GitHub PR again from this PR.
        </p>
        {unlink.error ? (
          <p className="mt-3 text-sm text-destructive">
            {errorMessage(unlink.error, "Unlink failed")}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="secondary"
            disabled={unlink.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={unlink.isPending}
            onClick={() => unlink.mutate(undefined, { onSuccess: onClose })}
          >
            {unlink.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : null}
            {unlink.isPending ? "Unlinking…" : "Unlink"}
          </Button>
        </div>
      </div>
    </div>
  );
}
