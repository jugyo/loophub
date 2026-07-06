// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, comments, the linked PR, plus the write operations v1 supports
// — comment posting and close/reopen. Body and comments are stored as plain
// Markdown and rendered as GFM via <Markdown>.

import { Link } from "@tanstack/react-router";
import { ChevronDown, Loader2, Play, Terminal } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  CodingAgent,
  GlobalSettings,
  Issue,
  IssueComment,
  IssueGroupWithMembers,
  LinkedPull,
} from "@/api/types";
import { BuildStatusLabel } from "@/components/build-status-label";
import { IssueRow } from "@/components/dashboard-rows";
import { DetailHeaderTitle } from "@/components/detail-title";
import { IssueDevInfo } from "@/components/dev-info";
import { HerdrBadge, isPullHerdrWorking } from "@/components/herdr-badge";
import { LabelChip } from "@/components/label-chip";
import { LinkedGithubPrBadge } from "@/components/linked-github-pr-badge";
import { Markdown } from "@/components/markdown";
import { RelatedSessions } from "@/components/related-sessions";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { useToast } from "@/components/toast";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CODING_AGENT_LABELS, MODEL_SUGGESTIONS } from "@/lib/agent-models";
import {
  issueBuildButtonState,
  linkedPullStateBadge,
  linkedPullStatus,
  stateBadge,
} from "@/lib/badges";
import { usePageTitle } from "@/lib/page-title";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useImageUpload } from "@/lib/use-image-upload";
import { cn } from "@/lib/utils";
import {
  useIssue,
  useIssueComments,
  useIssueGroups,
  usePostComment,
  useSetIssueState,
} from "@/queries/issues";
import { useSettings } from "@/queries/settings";
import { useFocusHerdrAgent, useHerdrSessions } from "@/queries/terminal";

export function IssueDetail({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const issueQuery = useIssue(owner, repo, number);
  const commentsQuery = useIssueComments(owner, repo, number);

  if (issueQuery.isLoading) {
    return (
      <div className="mx-auto flex max-w-content items-center gap-2 py-8 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (issueQuery.isError || !issueQuery.data) {
    return (
      <div className="mx-auto max-w-content rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load issue #{number}.
        {issueQuery.error instanceof Error
          ? ` ${issueQuery.error.message}`
          : null}
      </div>
    );
  }

  const issue = issueQuery.data;

  return (
    <div className="mx-auto flex max-w-content flex-col gap-6">
      <IssueHeader owner={owner} repo={repo} issue={issue} />

      <LinkedPullSummary owner={owner} repo={repo} issue={issue} />

      <GroupedIssues owner={owner} repo={repo} number={number} />

      <RelatedSessions
        owner={owner}
        repo={repo}
        sessions={issue.related_sessions}
      />

      <section className="flex flex-col gap-6 pb-6">
        <CommentList
          owner={owner}
          repo={repo}
          comments={commentsQuery.data}
          isLoading={commentsQuery.isLoading}
          isError={commentsQuery.isError}
        />

        <CommentForm owner={owner} repo={repo} number={number} />
      </section>
    </div>
  );
}

// "Other issues in the same group" (#314): for each group this issue belongs to, list its other
// members so a reader can see what comes next when working through the group in order. Reuses the
// shared IssueRow (no bespoke row). The current issue is dropped from each list; a group that holds
// only this issue is skipped. Hides entirely when the issue belongs to no group (or all groups are
// solo), so ungrouped issues stay uncluttered.
function GroupedIssues({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const query = useIssueGroups(owner, repo, number);
  const groups = (query.data ?? [])
    .map(
      (g): IssueGroupWithMembers => ({
        ...g,
        members: g.members.filter((m) => m.number !== number),
      }),
    )
    .filter((g) => g.members.length > 0);

  if (groups.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      {groups.map(({ group, members }) => (
        <div key={group.id} className="flex flex-col gap-2">
          <h2 className="text-lg font-semibold">
            Group: {group.name}{" "}
            <span className="text-sm font-normal text-muted-foreground">
              ({members.length} other{members.length === 1 ? "" : "s"})
            </span>
          </h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {members.map((m) => (
              <li key={m.number}>
                <IssueRow owner={owner} repo={repo} issue={m} />
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

function IssueHeader({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const setState = useSetIssueState(owner, repo, issue.number);
  const state = stateBadge(issue, "issues");
  const buildState = issueBuildButtonState(issue);
  usePageTitle([`${owner}/${repo}`, `Issue #${issue.number}`, issue.title]);

  return (
    <div className="flex flex-col gap-3">
      <DetailHeaderTitle
        kind="Issue"
        number={issue.number}
        title={issue.title}
      />

      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {state ? <Badge tone={state.tone}>{state.label}</Badge> : null}
        <span>
          @{issue.user.login} · opened {relativeTime(issue.created_at)}
        </span>
      </div>

      {issue.labels.length > 0 ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} owner={owner} repo={repo} />
          ))}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-md border bg-muted/30">
        {issue.body ? (
          <Markdown owner={owner} repo={repo} className="p-4">
            {issue.body}
          </Markdown>
        ) : (
          <p className="p-4 text-sm text-muted-foreground">No description.</p>
        )}
        <IssueDevInfo owner={owner} repo={repo} number={issue.number} />
      </div>

      <div className="flex flex-wrap justify-end gap-2">
        <IssueHerdrPaneButton owner={owner} repo={repo} issue={issue} />
        <Button
          variant="secondary"
          disabled={setState.isPending}
          onClick={() =>
            setState.mutate(issue.state === "open" ? "closed" : "open")
          }
        >
          {setState.isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : null}
          {issue.state === "open" ? "Close" : "Reopen"}
        </Button>
        {buildState === "build" ? (
          <BuildControls owner={owner} repo={repo} issue={issue} />
        ) : (
          <BuildStatusLabel state={buildState} />
        )}
      </div>
    </div>
  );
}

function IssueHerdrPaneButton({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const paneId = issue.herdr_pane?.pane_id;
  const focus = useFocusHerdrAgent();
  const { showError } = useToast();
  if (!paneId) return null;
  return (
    <Button
      variant="secondary"
      disabled={focus.isPending}
      title="Open the terminal that created this issue in Herdr"
      aria-label={`Open in Herdr for issue #${issue.number}`}
      onClick={() =>
        focus.mutate(
          { repo: `${owner}/${repo}`, paneId },
          {
            onError: (e) =>
              showError(
                e instanceof Error ? e.message : "Failed to open in Herdr.",
              ),
          },
        )
      }
    >
      {focus.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <Terminal className="size-4" />
      )}
      Open in Herdr
    </Button>
  );
}

// The Build button plus its agent/model dropdown (#637). The plain button launches with the
// Settings defaults (unchanged behavior); the chevron opens a panel to pick a coding agent and
// model for a single launch, which spawns `lh dev <n> --herdr [--auto] --claude-code|--codex
// --model <name>` without touching the persisted `codingAgent` / per-agent `defaultModel`. The
// autoMode/tooltip still reflect the resolved default agent, since that is what a plain click runs.
function BuildControls({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const { launchTerminal } = useTerminalLauncher();
  const { data: settings } = useSettings();
  const [isBuildLoading, startBuildLoading] = useFixedLoading();
  const [menuOpen, setMenuOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const defaultAgent: CodingAgent = settings?.codingAgent ?? "claude-code";
  const autoModeOnBuild = settings
    ? settings.agents[defaultAgent]?.autoModeOnBuild
    : false;
  // Display-only tooltip for the plain button: it never reaches the wire, it only shows what a
  // default (no-override) click runs (#584, #593).
  const buildCommand = autoModeOnBuild
    ? `lh dev ${issue.number} --herdr --auto`
    : `lh dev ${issue.number} --herdr`;

  // Close the dropdown on outside click / Escape (mirrors PullDebugMenu's native dismissal).
  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setMenuOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMenuOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // `override` set => the dropdown launch (one-shot agent/model); undefined => the plain button
  // (default resolution). A blank model is omitted so `lh dev` falls back to the per-agent default.
  function build(override?: { agent: CodingAgent; model: string }) {
    startBuildLoading();
    setMenuOpen(false);
    const model = override?.model.trim();
    launchTerminal({
      repo: `${owner}/${repo}`,
      label: `Issue #${issue.number} - ${issue.title}`,
      workflow: "issue-dev",
      issueNumber: issue.number,
      agent: override?.agent,
      model: model ? model : undefined,
    });
  }

  return (
    <div ref={containerRef} className="relative inline-flex">
      <Button
        className="rounded-r-none"
        title={`Start \`${buildCommand}\` in a terminal`}
        disabled={isBuildLoading}
        onClick={() => build()}
      >
        {isBuildLoading ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Play className="size-4" />
        )}
        Build
      </Button>
      <Button
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label="Choose agent and model"
        title="Choose agent and model for this launch"
        disabled={isBuildLoading}
        className="rounded-l-none border-l border-primary-foreground/25 px-2"
        onClick={() => setMenuOpen((v) => !v)}
      >
        <ChevronDown className="size-4" />
      </Button>
      {menuOpen && settings ? (
        <BuildDropdown
          settings={settings}
          disabled={isBuildLoading}
          onBuild={(agent, model) => build({ agent, model })}
        />
      ) : null}
    </div>
  );
}

// Dropdown panel for a one-shot Build (#637): pick a coding agent (segmented control) and a model
// (a native <input list> + <datalist> combobox — same picklist-plus-free-text pattern as the
// Settings AgentModelInput, sharing MODEL_SUGGESTIONS). Both default to the current Settings values;
// changing the agent resets the model draft to that agent's default so the picklist stays coherent.
// Nothing here writes settings — the choice only feeds this launch.
function BuildDropdown({
  settings,
  disabled,
  onBuild,
}: {
  settings: GlobalSettings;
  disabled: boolean;
  onBuild: (agent: CodingAgent, model: string) => void;
}) {
  const [agent, setAgent] = useState<CodingAgent>(settings.codingAgent);
  const [model, setModel] = useState(
    settings.agents[settings.codingAgent]?.model ?? "",
  );
  const listId = useId();

  function selectAgent(next: CodingAgent) {
    setAgent(next);
    setModel(settings.agents[next]?.model ?? "");
  }

  return (
    <div
      role="menu"
      className="absolute right-0 top-full z-50 mt-1 w-72 rounded-md border bg-background p-3 text-left shadow-md"
    >
      <p className="mb-1 text-xs font-medium text-muted-foreground">Agent</p>
      <div className="mb-3 flex gap-1">
        {(Object.keys(CODING_AGENT_LABELS) as CodingAgent[]).map((a) => {
          const active = agent === a;
          return (
            <button
              key={a}
              type="button"
              aria-pressed={active}
              className={cn(
                "flex-1 rounded-md border px-2 py-1.5 text-sm",
                active
                  ? "border-primary bg-primary/10 font-medium"
                  : "hover:bg-accent hover:text-accent-foreground",
              )}
              onClick={() => selectAgent(a)}
            >
              {CODING_AGENT_LABELS[a]}
            </button>
          );
        })}
      </div>

      <label
        htmlFor={`${listId}-model`}
        className="mb-1 block text-xs font-medium text-muted-foreground"
      >
        Model
      </label>
      <input
        id={`${listId}-model`}
        type="text"
        list={listId}
        placeholder="Default"
        className="mb-3 w-full rounded-md border bg-background px-3 py-1.5 text-sm"
        value={model}
        onChange={(e) => setModel(e.target.value)}
      />
      <datalist id={listId}>
        {MODEL_SUGGESTIONS[agent].map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      <Button
        className="w-full"
        disabled={disabled}
        onClick={() => onBuild(agent, model)}
      >
        <Play className="size-4" />
        Build with {CODING_AGENT_LABELS[agent]}
      </Button>
    </div>
  );
}

// Standalone "Linked pull request(s)" section summarizing the issue's linked
// PR(s) at a glance (#269). Rendered as its own section under the issue header
// (not inside it) so it reads as a related entity — not part of the issue body,
// and not a target of the issue's Close/Build actions. A labelled heading makes
// that boundary explicit. Each row is a toned `PR #n` link pill + a status word
// + the PR title (also a link). Renders nothing when no PR is linked. Multiple
// linked PRs stack vertically — the issue-detail response sends a single
// `linked_pull_request`, but the plural `linked_pull_requests` is honored when
// present so the display never breaks.
function LinkedPullSummary({
  owner,
  repo,
  issue,
}: {
  owner: string;
  repo: string;
  issue: Issue;
}) {
  const pulls =
    issue.linked_pull_requests ??
    (issue.linked_pull_request ? [issue.linked_pull_request] : []);
  if (pulls.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium text-muted-foreground">
        {pulls.length > 1 ? "Linked pull requests" : "Linked pull request"}
      </h2>
      {pulls.map((pull) => (
        <LinkedPullRow
          key={pull.number}
          owner={owner}
          repo={repo}
          pull={pull}
        />
      ))}
    </section>
  );
}

function LinkedPullRow({
  owner,
  repo,
  pull,
}: {
  owner: string;
  repo: string;
  pull: LinkedPull;
}) {
  const { data: herdrSessions } = useHerdrSessions();
  const agentWorking = isPullHerdrWorking(
    herdrSessions,
    `${owner}/${repo}`,
    pull.number,
  );
  // Prefer the richer git-derived status (working/review/mergeable) when the
  // response carries those fields; the issue-detail summary lacks them, so fall
  // back to the always-available state badge (open/merged/closed).
  const status =
    linkedPullStatus(pull, { agentWorking }) ?? linkedPullStateBadge(pull);
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm">
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className={cn(
          badgeVariants({ tone: status.tone }),
          "shrink-0 hover:opacity-80",
        )}
      >
        PR #{pull.number}
      </Link>
      <LinkedGithubPrBadge github_pull={pull.github_pull} />
      <span
        className="shrink-0 font-medium text-muted-foreground"
        title={status.title}
      >
        {status.label}
      </span>
      <Link
        to="/r/$owner/$repo/pulls/$number"
        params={{ owner, repo, number: String(pull.number) }}
        className="min-w-0 flex-1 truncate text-foreground hover:underline"
        title={pull.title}
      >
        {pull.title}
      </Link>
      {/* Same badge as the issue-list linked-PR sub-row (#609): shown only while a herdr
          terminal runs this PR's worktree; clicking focuses its pane. */}
      <HerdrBadge owner={owner} repo={repo} pull={pull.number} />
    </div>
  );
}

function CommentList({
  owner,
  repo,
  comments,
  isLoading,
  isError,
}: {
  owner: string;
  repo: string;
  comments: IssueComment[] | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading comments…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
        Failed to load comments.
      </div>
    );
  }
  if (!comments || comments.length === 0) {
    return <p className="text-sm text-muted-foreground">No comments yet.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      {comments.map((c) => (
        <article key={c.id} className="rounded-md border p-3">
          <header className="mb-1 text-sm font-medium">
            @{c.user.login}{" "}
            <span className="text-xs font-normal text-muted-foreground">
              {relativeTime(c.created_at)}
            </span>
          </header>
          <Markdown owner={owner} repo={repo}>
            {c.body}
          </Markdown>
        </article>
      ))}
    </div>
  );
}

function CommentForm({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const [body, setBody] = useState("");
  const post = usePostComment(owner, repo, number);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const image = useImageUpload({ value: body, onChange: setBody, textareaRef });

  function submit() {
    const trimmed = body.trim();
    if (!trimmed || post.isPending) return;
    post.mutate(trimmed, { onSuccess: () => setBody("") });
  }

  return (
    <div className="flex flex-col gap-2">
      <textarea
        ref={textareaRef}
        aria-label="Add a comment"
        placeholder="Add a comment (paste or drop an image to attach)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={image.onPaste}
        onDrop={image.onDrop}
        onDragOver={image.onDragOver}
        rows={4}
        className="min-h-24 rounded-md border bg-background p-3 text-sm"
      />
      {image.uploading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Uploading image…
        </p>
      ) : null}
      {post.isError ? (
        <p className="text-sm text-destructive">
          {post.error instanceof Error ? post.error.message : "Failed to post."}
        </p>
      ) : null}
      <div className="flex justify-end">
        <Button disabled={!body.trim() || post.isPending} onClick={submit}>
          {post.isPending ? <Loader2 className="size-4 animate-spin" /> : null}
          Comment
        </Button>
      </div>
    </div>
  );
}
