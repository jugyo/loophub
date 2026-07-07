// Related sessions list for a PR or issue (#298). Shows every session linked to the PR/issue
// (dev, review, issue-create, …) newest-first, with its kind, runtime, and when it was linked.
//
// Every session is treated equally (#401): there is no muted "superseded / not this PR's resume
// target" reason text. Rows expand to a copyable command, but do not launch a terminal directly.
//
// On PR detail, the current dev anchor row uses `lh resume <owner>/<repo>/<pr>` because that command
// restores/re-attaches the worktree before resuming. Other rows keep the direct `claude --resume`
// command because `lh resume --session <id>` does not resolve the original worktree cwd.
//
// Each row is expandable (#340): expanding reveals a copyable terminal command so a user can resume
// by hand. It is shown whenever the runtime resume judgment succeeded (serialize.ts: only
// "no-session" / "unknown-runtime" mean there is no claude session id; every other state has a valid
// id in `RelatedSession.session`).

import { ChevronRight } from "lucide-react";
import { useState } from "react";
import type { RelatedSession, RelatedSessionsUsage } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import type { BadgeTone } from "@/lib/badges";
import { formatCost, formatTokenCount } from "@/lib/session-usage";
import { relativeTime } from "@/lib/time";

// Session kind → badge tone (reuses the existing badge palette; no new CSS). Unknown kinds fall
// back to a neutral tone.
const KIND_TONE: Record<string, BadgeTone> = {
  dev: "agent",
  review: "open",
  "issue-create": "unknown",
};

const KIND_LABEL: Record<string, string> = {
  dev: "Implementation",
  review: "Review",
  "issue-create": "Issue creation",
};

// The issue-create session kind (#299): no worktree, resumes from the repo root (herdr's default
// cwd for a repo), so its Resume button needs no `cd` prefix.
const SESSION_KIND_ISSUE_CREATE = "issue-create";

// Non-resumable reason code → short human label. Only the two runtime-level reasons surface now —
// in the expanded row, explaining why even the raw `claude --resume` is unavailable. The
// `lh resume`-anchor reasons (superseded / not-anchor / resume-via-pull) are gone: every session is
// treated equally and no longer carries a "you can't resume this" annotation (#401).
const RESUME_REASON: Record<string, string> = {
  "unknown-runtime": "runtime not resumable",
  "no-session": "not resumable",
};

// Runtime-level reasons (from resolveRuntimeResume, serialize.ts) where there is no claude session id
// to hand to `claude --resume` — the runtime is not claude-code, or no session was ever recorded. For
// every other state (resumable, or an `lh resume` anchor reason like superseded / not-anchor /
// resume-via-pull) `RelatedSession.session` holds a valid claude session id, so the raw command works.
const NO_CLAUDE_RESUME = new Set(["no-session", "unknown-runtime"]);

function canClaudeResume(s: RelatedSession): boolean {
  return s.resume.resumable || !NO_CLAUDE_RESUME.has(s.resume.reason ?? "");
}

// Shell-quote a path for the copyable `cd <path>` command (#345). Worktree paths under
// ~/.loophub/worktrees are space-free, so the common case stays unquoted and readable; quote only
// when the path carries characters the shell would split on or interpret (spaces, globs, etc.),
// using POSIX single-quote escaping so the copied command is always safe to paste.
function shellArg(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p)
    ? p
    : `'${p.replace(/'/g, `'\\''`)}'`;
}

export function RelatedSessions({
  owner,
  repo,
  pullNumber,
  sessions,
  cwd,
}: {
  owner: string;
  repo: string;
  pullNumber?: number;
  sessions: RelatedSession[] | undefined;
  // The directory `claude --resume` should run in. When set, the copyable command is prepended with
  // `cd <cwd> && …` so resume runs from the right place. Pass the PR's dev worktree path on PR
  // detail (shared by all the PR's sessions); omit on issue detail, where an issue-create session
  // resumes from the repo root and any other session has no client-side worktree path.
  cwd?: string;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!sessions || sessions.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Sessions</h2>
      <ul className="flex flex-col gap-2">
        {sessions.map((s) => {
          const claudeResumable = canClaudeResume(s);
          const reason = s.resume.reason
            ? (RESUME_REASON[s.resume.reason] ?? s.resume.reason)
            : null;
          // `claude --resume <external_session>` (#340; embeds RelatedSession.session, the value
          // claude consumes). The id is shell-quoted (defense in depth): a server-validated UUID
          // passes through unquoted, but a non-UUID id can never inject tokens into the command.
          const claudeResume = `claude --resume ${shellArg(s.session)}`;
          // An issue-create session resumes from the repo root (the terminal's default cwd), so it
          // must NOT inherit an incidental worktree `cwd` — claude resolves a session only from its
          // original directory. `cdPrefix` is the worktree to `cd` into, or null to run bare from the
          // repo root: the PR's shared worktree `cwd` for a worktree-backed session, never for an
          // issue-create one.
          const resumesFromRepoRoot = s.kind === SESSION_KIND_ISSUE_CREATE;
          const cdPrefix = cwd != null && !resumesFromRepoRoot ? cwd : null;
          const usesPullResume =
            pullNumber != null && s.kind === "dev" && s.resume.resumable;
          // Display form for the copyable block — split with a `\` line-continuation so the long
          // command reads cleanly; the copied text keeps the `\`+newline so pasting runs as one.
          const claudeCommand = cdPrefix
            ? `cd ${shellArg(cdPrefix)} && \\\n  ${claudeResume}`
            : claudeResume;
          const resumeCommand = usesPullResume
            ? `lh resume ${shellArg(`${owner}/${repo}/${pullNumber}`)}`
            : claudeCommand;
          const isOpen = expanded[s.id] ?? false;
          return (
            <li key={s.id} className="rounded-md border text-sm">
              {/* Header row: expandable metadata only. No per-row reason text or terminal-launch
                  button: every session is treated the same (#401). */}
              <div className="flex items-start gap-2 p-3">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [s.id]: !isOpen }))
                  }
                  aria-expanded={isOpen}
                  aria-controls={`session-detail-${s.id}`}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-left"
                >
                  <ChevronRight
                    className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${
                      isOpen ? "rotate-90" : ""
                    }`}
                  />
                  <Badge
                    tone={s.kind ? (KIND_TONE[s.kind] ?? "unknown") : "unknown"}
                  >
                    {s.kind ?? "session"}
                  </Badge>
                  <span className="font-medium break-words">
                    {s.name ?? s.agent}
                  </span>
                  {s.runtime ? (
                    <code className="shrink-0 whitespace-nowrap rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
                      {s.runtime}
                    </code>
                  ) : null}
                  <span className="whitespace-nowrap text-xs text-muted-foreground">
                    linked {relativeTime(s.linked_at ?? s.created_at)}
                  </span>
                </button>
              </div>
              {isOpen ? (
                <div
                  id={`session-detail-${s.id}`}
                  className="flex flex-col gap-2 border-t px-3 py-3"
                >
                  {claudeResumable ? (
                    <>
                      <p className="text-xs text-muted-foreground">
                        Resume in your own terminal:
                      </p>
                      <div className="flex items-center gap-1">
                        <code className="flex-1 overflow-x-auto whitespace-pre rounded bg-muted px-2 py-1.5 font-mono text-xs">
                          {resumeCommand}
                        </code>
                        <CopyButton
                          value={resumeCommand}
                          label="Copy resume command"
                        />
                      </div>
                      {cwd || usesPullResume ? null : (
                        <p className="text-xs text-muted-foreground">
                          Run it in the session's working directory (the repo
                          root for an issue-create session, or the PR's worktree
                          for a dev/review session).
                        </p>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Cannot resume from a terminal
                      {reason ? ` — ${reason}` : ""}.
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Dedicated token usage/cost section for PR detail (#810): totals plus a per-session-kind
// breakdown (dev/review/issue-create/…), kept separate from the Sessions list so that section can
// stay a simple session index. Issue detail does not render this — RelatedSessionsUsage is only
// computed for pulls (core/serialize.ts pullJSON).
export function TokenUsageSummary({ usage }: { usage: RelatedSessionsUsage }) {
  const hasUsage = usage.sessions_with_usage > 0;
  const totalTokens = Math.max(usage.total_tokens, 0);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Token usage</h2>
      <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-3 text-sm">
        <dl className="grid grid-cols-2 gap-2">
          <div className="rounded-md border bg-background/60 p-2">
            <dt className="text-xs text-muted-foreground">Total tokens</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {hasUsage ? formatTokenCount(usage.total_tokens) : "n/a"}
            </dd>
          </div>
          <div className="rounded-md border bg-background/60 p-2">
            <dt className="text-xs text-muted-foreground">Total cost</dt>
            <dd className="mt-1 font-medium tabular-nums">
              {formatCost(usage.cost_usd)}
            </dd>
          </div>
        </dl>
        {usage.by_kind.length > 0 ? (
          <div className="flex flex-col gap-2 border-t pt-3">
            <div className="flex items-center justify-between gap-2 text-xs">
              <span className="font-medium">By category</span>
              <span className="text-muted-foreground">
                {usage.by_kind.length} categories
              </span>
            </div>
            <ul className="flex flex-col gap-2">
              {usage.by_kind.map((k) => {
                const share =
                  totalTokens > 0 ? k.total_tokens / totalTokens : 0;
                const percent = formatPercent(share);
                const barPercent = share > 0 ? Math.max(2, share * 100) : 0;
                return (
                  <li key={k.kind} className="flex flex-col gap-1.5">
                    <div className="flex min-w-0 items-center justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2">
                        <Badge tone={KIND_TONE[k.kind] ?? "unknown"}>
                          {KIND_LABEL[k.kind] ?? k.kind}
                        </Badge>
                        <span className="truncate text-xs text-muted-foreground">
                          {k.sessions_with_usage} session
                          {k.sessions_with_usage === 1 ? "" : "s"}
                        </span>
                      </div>
                      <span className="shrink-0 text-xs font-medium tabular-nums">
                        {percent}
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${barPercent}%` }}
                      />
                    </div>
                    <dl className="grid grid-cols-2 gap-2 text-xs">
                      <div className="min-w-0">
                        <dt className="text-muted-foreground">Tokens</dt>
                        <dd className="truncate font-medium tabular-nums">
                          {formatTokenCount(k.total_tokens)}
                        </dd>
                      </div>
                      <div className="min-w-0 text-right">
                        <dt className="text-muted-foreground">Cost</dt>
                        <dd className="truncate font-medium tabular-nums">
                          {formatCost(k.cost_usd)}
                        </dd>
                      </div>
                    </dl>
                    {k.subagents?.length ? (
                      <div className="ml-2 flex flex-col gap-1.5 border-l pl-2">
                        <div className="text-xs font-medium text-muted-foreground">
                          Subagents included in total
                        </div>
                        <ul className="flex flex-col gap-1.5">
                          {k.subagents.map((subagent) => (
                            <li
                              key={`${subagent.session_id}:${subagent.source_id}`}
                              className="min-w-0"
                              title={subagent.source_id}
                            >
                              <div className="flex min-w-0 items-baseline justify-between gap-2">
                                <span className="truncate text-xs font-medium">
                                  {subagent.label ?? subagent.source_id}
                                </span>
                                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                                  {formatCost(subagent.cost_usd)}
                                </span>
                              </div>
                              <div className="truncate text-xs tabular-nums text-muted-foreground">
                                {formatTokenCount(subagent.total_tokens)} tokens
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-3 text-center text-xs text-muted-foreground">
            No token usage recorded yet.
          </div>
        )}
        {usage.has_unknown_cost ? (
          <p className="border-t pt-2 text-xs text-muted-foreground">
            Some session costs are unavailable and counted as n/a.
          </p>
        ) : null}
      </div>
    </section>
  );
}

function formatPercent(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0%";
  const percent = value * 100;
  if (percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}
