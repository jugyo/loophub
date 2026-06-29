// Related sessions list for a PR or issue (#298). Shows every session linked to the PR/issue
// (dev, review, issue-create, …) newest-first, with its kind, runtime, and when it was linked.
// A session the server reports as resumable gets a Resume button that runs `lh resume …` in the
// built-in terminal: `lh resume <pr>` on PR detail (re-enters the dev worktree), or
// `lh resume --session <id> --repo <owner>/<repo>` on issue detail for an issue-create session
// (#299 — no worktree, resumes the filing session in the repo root). Non-resumable sessions show a
// short, muted reason so it is clear why they cannot be resumed (the AC's "resume 不可なものは
// その旨を示す"). The whole section hides when there are no linked sessions, so PRs/issues without a
// dev loop stay uncluttered.
//
// Each row is also expandable (#340): expanding reveals a copyable `claude --resume <external_session>`
// command so a user can resume the session from any terminal, not only via the built-in `lh resume`.
// The raw `claude` command is valid for far more sessions than `lh resume <pr>` targets — including a
// superseded dev session that `lh resume` can no longer reach — so it is shown whenever the runtime
// resume judgment succeeded (see serialize.ts: only the runtime-level reasons "no-session" /
// "unknown-runtime" mean there is no claude session id to pass; every other state still has a valid
// id in `RelatedSession.session`).
//
// When the session's cwd is known (#345 — PR detail's `worktree_path`), the command block is the
// joined form `cd <cwd> && claude --resume <id>` so a single copy resumes from the directory the
// session was saved in: `claude --resume` only resolves a session from its original cwd (sessions
// live at ~/.claude/projects/<dashed cwd>/<id>.jsonl). Without a cwd (issue detail, where the path
// is not available client-side) it falls back to the bare command plus a prose hint.

import { ChevronRight, Play } from "lucide-react";
import { useState } from "react";
import type { RelatedSession } from "@/api/types";
import { CopyButton } from "@/components/copy-button";
import { useTerminal } from "@/components/terminal-controller";
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

// Non-resumable reason code → short human label.
const RESUME_REASON: Record<string, string> = {
  superseded: "superseded by a newer dev session",
  "not-anchor": "not this PR's resume target",
  "resume-via-pull": "resume from the linked PR",
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
  resumeNumber,
  cwd,
}: {
  owner: string;
  repo: string;
  sessions: RelatedSession[] | undefined;
  // The PR number used to build `lh resume <id>`. Pass on PR detail; omit on issue detail (an
  // issue-linked session resumes via its PR, so no per-row Resume button there).
  resumeNumber?: number;
  // The directory the `claude --resume` command should run in. When set, it is prepended to the
  // command as `cd <cwd> && …` so one copy resumes from the right place (no separate path row).
  // Pass the PR's dev worktree path on PR detail; omit on issue detail (the repo-root path is not
  // available client-side, so the expanded view notes the directory in prose instead).
  cwd?: string;
}) {
  const { openTerminal } = useTerminal();
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  if (!sessions || sessions.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold">Sessions</h2>
      <ul className="flex flex-col gap-2">
        {sessions.map((s) => {
          const canResume = s.resume.resumable;
          // PR detail re-enters the PR's worktree by number; issue detail resumes the issue-create
          // session by its id in the repo root (#299). resumeNumber present ⇒ PR container.
          // `--session` takes the session *row id* (s.id), which the CLI resolves via
          // getAgentSession(id) → external_session for `claude --resume`. Pass s.id, not s.session
          // (external_session): the two coincide for an issue-create session today, but the row id
          // is the lookup key resolveSession contracts on.
          const resumeCommand =
            resumeNumber != null
              ? `lh resume ${owner}/${repo}/${resumeNumber}`
              : `lh resume --session ${s.id} --repo ${owner}/${repo}`;
          const reason = s.resume.reason
            ? (RESUME_REASON[s.resume.reason] ?? s.resume.reason)
            : null;
          // The command a user runs in their own terminal. The base is `claude --resume
          // <external_session>` (#340; embeds RelatedSession.session, the value claude consumes).
          // With a known cwd (#345) it becomes the joined `cd <cwd> && claude --resume <id>` so one
          // copy resumes from the right directory; without a cwd the bare command plus the prose
          // hint below covers it. The id is shell-quoted like the path (defense in depth): a
          // server-validated UUID passes through unquoted, but the component does not assume that,
          // so a non-UUID id can never inject tokens into the copyable command. The joined form is
          // split across two lines with a `\` shell line-continuation so the long command reads
          // cleanly; the copied text keeps the `\`+newline, so pasting still runs it as one command.
          const claudeResume = `claude --resume ${shellArg(s.session)}`;
          const claudeCommand = cwd
            ? `cd ${shellArg(cwd)} && \\\n  ${claudeResume}`
            : claudeResume;
          const claudeResumable = canClaudeResume(s);
          const isOpen = expanded[s.id] ?? false;
          return (
            <li key={s.id} className="rounded-md border text-sm">
              <div className="flex flex-wrap items-center gap-2 p-3">
                <button
                  type="button"
                  onClick={() =>
                    setExpanded((prev) => ({ ...prev, [s.id]: !isOpen }))
                  }
                  aria-expanded={isOpen}
                  aria-controls={`session-detail-${s.id}`}
                  className="flex flex-1 flex-wrap items-center gap-2 text-left"
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
                  <span className="font-medium">{s.name ?? s.agent}</span>
                  {s.runtime ? (
                    <code className="rounded bg-muted px-1 py-0.5 text-xs text-muted-foreground">
                      {s.runtime}
                    </code>
                  ) : null}
                  <span className="text-xs text-muted-foreground">
                    linked {relativeTime(s.linked_at ?? s.created_at)}
                  </span>
                </button>
                <span className="ml-auto flex items-center gap-2">
                  {canResume ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      title={`Resume \`${resumeCommand}\` in a terminal`}
                      onClick={() =>
                        openTerminal({
                          command: resumeCommand,
                          repo: `${owner}/${repo}`,
                          label: `resume ${s.name ?? s.kind ?? s.id}`,
                        })
                      }
                    >
                      <Play className="size-3.5" />
                      Resume
                    </Button>
                  ) : reason ? (
                    <span className="text-xs text-muted-foreground">
                      {reason}
                    </span>
                  ) : null}
                </span>
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
