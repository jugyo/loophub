// Issue detail view (/r/:owner/:repo/issues/:number). v1 parity: title, body,
// labels, state, comments, the linked PR, plus the write operations v1 supports
// — comment posting and close/reopen. Body and comments are stored as plain
// Markdown and rendered as GFM via <Markdown>.

import { useNavigate } from "@tanstack/react-router";
import { ChevronDown, Loader2, Play } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  CodingAgent,
  GlobalSettings,
  Issue,
  IssueComment,
} from "@/api/types";
import { BuildStatusLabel } from "@/components/build-status-label";
import { DetailHeaderTitle } from "@/components/detail-title";
import { IssueDevInfo } from "@/components/dev-info";
import { IssueBranchChip } from "@/components/issue-branch-chip";
import { IssueHerdrSection } from "@/components/issue-herdr-section";
import { LabelChip } from "@/components/label-chip";
import { LinkedPullSummaryRow } from "@/components/linked-pull-summary";
import { Markdown } from "@/components/markdown";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CODING_AGENT_LABELS, MODEL_SUGGESTIONS } from "@/lib/agent-models";
import { issueBuildButtonState, stateBadge } from "@/lib/badges";
import {
  hasPlainShortcutModifiers,
  isEditableShortcutTarget,
  isShortcutOverlayActive,
} from "@/lib/keyboard-shortcuts";
import { usePageTitle } from "@/lib/page-title";
import { relativeTime } from "@/lib/time";
import { useFixedLoading } from "@/lib/use-fixed-loading";
import { useImageUpload } from "@/lib/use-image-upload";
import { cn } from "@/lib/utils";
import {
  useIssue,
  useIssueComments,
  usePostComment,
  useSetIssueState,
} from "@/queries/issues";
import { useSettings } from "@/queries/settings";

export function IssueDetail({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const navigate = useNavigate();
  const issueQuery = useIssue(owner, repo, number);
  const commentsQuery = useIssueComments(owner, repo, number);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.key !== "u" ||
        hasPlainShortcutModifiers(event) ||
        isEditableShortcutTarget(event.target) ||
        isShortcutOverlayActive(event.target)
      ) {
        return;
      }
      event.preventDefault();
      navigate({ to: "/r/$owner/$repo/issues", params: { owner, repo } });
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [navigate, owner, repo]);

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

      <IssueHerdrSection owner={owner} repo={repo} issue={issue} />

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

      {issue.labels.length > 0 || issue.target_branch ? (
        <div className="flex flex-wrap gap-1">
          {issue.labels.map((l) => (
            <LabelChip key={l.name} name={l.name} owner={owner} repo={repo} />
          ))}
          <IssueBranchChip branch={issue.target_branch} />
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

// The Build button plus its agent/model dropdown (#637). The plain button launches with the
// Settings defaults (unchanged behavior); the chevron opens a panel to pick a coding agent and
// model for a single launch, which spawns `lh build <n> --herdr [--auto] --claude-code|--codex
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

  const defaultAgent: CodingAgent = settings?.codingAgent ?? "claude-code";
  const autoModeOnBuild = settings
    ? settings.agents[defaultAgent]?.autoModeOnBuild
    : false;
  // Display-only tooltip for the plain button: it never reaches the wire, it only shows what a
  // default (no-override) click runs (#584, #593).
  const buildCommand = autoModeOnBuild
    ? `lh build ${issue.number} --herdr --auto`
    : `lh build ${issue.number} --herdr`;

  // `override` set => the dropdown launch (one-shot agent/model); undefined => the plain button
  // (default resolution). A blank model is omitted so `lh build` falls back to the per-agent default.
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
    <div className="inline-flex">
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
      <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Choose agent and model"
            title="Choose agent and model for this launch"
            disabled={isBuildLoading || !settings}
            className="rounded-l-none border-l border-primary-foreground/25 px-2"
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        {settings ? (
          <DropdownMenuContent align="end" className="w-72 p-3">
            <BuildDropdown
              settings={settings}
              disabled={isBuildLoading}
              onBuild={(agent, model) => build({ agent, model })}
            />
          </DropdownMenuContent>
        ) : null}
      </DropdownMenu>
    </div>
  );
}

// Dropdown panel for a one-shot Build (#637): pick a coding agent (segmented control) and a model
// with the same shadcn dropdown style used by Settings. Both default to the current Settings values;
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
  const customModelId = useId();

  function selectAgent(next: CodingAgent) {
    setAgent(next);
    setModel(settings.agents[next]?.model ?? "");
  }

  return (
    <>
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

      <p className="mb-1 block text-xs font-medium text-muted-foreground">
        Model
      </p>
      <BuildModelDropdown
        agent={agent}
        model={model}
        disabled={disabled}
        onChange={setModel}
      />
      <label
        htmlFor={`${customModelId}-custom-model`}
        className="mt-3 mb-1 block text-xs font-medium text-muted-foreground"
      >
        Custom model
      </label>
      <input
        id={`${customModelId}-custom-model`}
        type="text"
        placeholder="Default"
        className="w-full rounded-md border bg-background px-3 py-1.5 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        value={model}
        disabled={disabled}
        onChange={(e) => setModel(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" || e.key === "Tab") return;
          e.stopPropagation();
        }}
      />

      <Button
        className="mt-3 w-full"
        disabled={disabled}
        onClick={() => onBuild(agent, model)}
      >
        <Play className="size-4" />
        Build with {CODING_AGENT_LABELS[agent]}
      </Button>
    </>
  );
}

function BuildModelDropdown({
  agent,
  model,
  disabled,
  onChange,
}: {
  agent: CodingAgent;
  model: string;
  disabled: boolean;
  onChange: (model: string) => void;
}) {
  const suggestions = MODEL_SUGGESTIONS[agent];
  const options = suggestions.includes(model)
    ? suggestions
    : [model, ...suggestions];

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger
        aria-label="Model"
        title={model || "Default"}
        disabled={disabled}
        className="w-full justify-between border bg-background px-3 font-normal shadow-sm"
      >
        <span className="min-w-0 truncate">{model || "Default"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[min(20rem,calc(100vh-5rem))] min-w-56 overflow-y-auto">
        {options.map((candidate) => {
          const selected = candidate === model;
          return (
            <DropdownMenuItem
              key={candidate || "__default__"}
              onSelect={(event) => {
                event.preventDefault();
                onChange(candidate);
              }}
              aria-current={selected ? "true" : undefined}
              className={cn(
                "justify-between",
                selected && "bg-accent text-accent-foreground",
              )}
            >
              <span className="min-w-0 truncate">{candidate || "Default"}</span>
              {selected ? <DropdownMenuItemIndicator /> : null}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

// Standalone "Linked pull request(s)" section summarizing the issue's linked
// PR(s) at a glance (#269). Rendered as its own section under the issue header
// (not inside it) so it reads as a related entity — not part of the issue body,
// and not a target of the issue's Close/Build actions. A labelled heading makes
// that boundary explicit. Each row is a toned `PR #n` link pill + a status word
// + a visible PR title link. Renders nothing when no PR is linked. Multiple
// linked PRs stack vertically.
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
        <LinkedPullSummaryRow
          key={pull.number}
          owner={owner}
          repo={repo}
          pull={pull}
        />
      ))}
    </section>
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
