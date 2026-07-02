// Related sessions list for a PR or issue (#298). Shows every session linked to the PR/issue
// (dev, review, issue-create, …) newest-first, with its kind, runtime, and when it was linked.
//
// Every session is treated equally (#401): there is no special "anchor" row and no muted
// "superseded / not this PR's resume target" reason text. A session whose runtime is resumable
// (claude-code with a stored session id) gets a Resume button that launches `claude --resume <id>`
// directly in the built-in terminal — the same raw command resumes any such session, not just the
// single dev session `lh resume <pr>` used to target. (We no longer call `lh resume`: it can only
// re-enter a PR's one anchor session, which is exactly the unequal treatment this view drops. The
// tradeoff: `claude --resume` needs the session's worktree to still exist on disk, whereas
// `lh resume` could re-attach a pruned worktree from the branch — an edge case, out of scope here.)
//
// `claude --resume` only resolves a session from its original cwd (sessions live at
// ~/.claude/projects/<dashed cwd>/<id>.jsonl), so the button appears only when that directory is
// known: PR detail passes the shared worktree `cwd` (#345 — `worktree_path`), used by all of the
// PR's sessions; an issue-create session (#299) has no worktree and resumes from the repo root,
// which is the terminal's default cwd, so a bare command works. An issue-linked dev/review session
// on issue detail has no client-side worktree path, so it gets no button — but the row still expands
// to a copyable command (below), so it is not visually singled out.
//
// Each row is expandable (#340): expanding reveals the copyable `claude --resume` command (joined as
// `cd <cwd> && …` when the cwd is known, #345) so a user can resume from any terminal. It is shown
// whenever the runtime resume judgment succeeded (serialize.ts: only "no-session" / "unknown-runtime"
// mean there is no claude session id; every other state has a valid id in `RelatedSession.session`).

import { ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import type { RelatedSession } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { useTerminalLauncher } from "@/components/terminal-controller";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BadgeTone } from "@/lib/badges";
import { relativeTime } from "@/lib/time";

// Session kind → badge tone (reuses the existing badge palette; no new CSS). Unknown kinds fall
// back to a neutral tone.
const KIND_TONE: Record<string, BadgeTone> = {
  dev: "agent",
  review: "open",
  "issue-create": "unknown",
};

// The issue-create session kind (#299): no worktree, resumes from the repo root (the built-in
// terminal's default cwd), so its Resume button needs no `cd` prefix.
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
  sessions,
  cwd,
}: {
  owner: string;
  repo: string;
  sessions: RelatedSession[] | undefined;
  // The directory `claude --resume` should run in. When set, the Resume button and the copyable
  // command are prepended with `cd <cwd> && …` so resume runs from the right place. Pass the PR's
  // dev worktree path on PR detail (shared by all the PR's sessions); omit on issue detail, where an
  // issue-create session resumes from the repo root (the terminal's default cwd) and any other
  // session has no client-side worktree path (no button — the expanded copy command covers it).
  cwd?: string;
}) {
  const { launchTerminal } = useTerminalLauncher();
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
          // Launchable in the built-in terminal only when runtime-resumable AND we know its directory:
          // a `cdPrefix` worktree, or the repo root for an issue-create session. Otherwise (an
          // issue-linked dev/review session with no client-side worktree path) there is no button;
          // the expanded copy command below is the fallback.
          const canRunInTerminal =
            claudeResumable && (cdPrefix != null || resumesFromRepoRoot);
          // Single-line form the Resume button runs in the built-in terminal (one command).
          const terminalCommand = cdPrefix
            ? `cd ${shellArg(cdPrefix)} && ${claudeResume}`
            : claudeResume;
          // Display form for the copyable block — split with a `\` line-continuation so the long
          // command reads cleanly; the copied text keeps the `\`+newline so pasting runs as one.
          const claudeCommand = cdPrefix
            ? `cd ${shellArg(cdPrefix)} && \\\n  ${claudeResume}`
            : claudeResume;
          const isOpen = expanded[s.id] ?? false;
          return (
            <li key={s.id} className="rounded-md border text-sm">
              {/* Header row: the expandable toggle (badge / name / runtime / linked time, allowed to
                  wrap) on the left, and — when the session can be launched in the built-in terminal —
                  a compact Resume button pinned top-right. No per-row reason text: every session is
                  treated the same (#401). */}
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
                {canRunInTerminal ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="shrink-0"
                    title={`Resume \`${terminalCommand}\` in a terminal`}
                    onClick={() =>
                      launchTerminal({
                        command: terminalCommand,
                        repo: `${owner}/${repo}`,
                        label: `Resume - ${s.name ?? s.kind ?? s.id}`,
                        workflow: "resume",
                        session: s.session,
                        cwd: cdPrefix ?? undefined,
                      })
                    }
                  >
                    <Play className="size-3.5" />
                    Resume
                  </Button>
                ) : null}
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
                          {claudeCommand}
                        </code>
                        <CopyButton
                          value={claudeCommand}
                          label="Copy resume command"
                        />
                      </div>
                      {cwd ? null : (
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
