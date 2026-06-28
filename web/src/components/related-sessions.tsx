// Related sessions list for a PR or issue (#298). Shows every session linked to the PR/issue
// (dev, review, issue-create, …) newest-first, with its kind, runtime, and when it was linked.
// A session the server reports as resumable gets a Resume button that runs `lh resume …` in the
// built-in terminal: `lh resume <pr>` on PR detail (re-enters the dev worktree), or
// `lh resume --session <id> --repo <owner>/<repo>` on issue detail for an issue-create session
// (#299 — no worktree, resumes the filing session in the repo root). Non-resumable sessions show a
// short, muted reason so it is clear why they cannot be resumed (the AC's "resume 不可なものは
// その旨を示す"). The whole section hides when there are no linked sessions, so PRs/issues without a
// dev loop stay uncluttered.

import { Play } from "lucide-react";
import type { RelatedSession } from "@/api/types";
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

export function RelatedSessions({
  owner,
  repo,
  sessions,
  resumeNumber,
}: {
  owner: string;
  repo: string;
  sessions: RelatedSession[] | undefined;
  // The PR number used to build `lh resume <id>`. Pass on PR detail; omit on issue detail (an
  // issue-linked session resumes via its PR, so no per-row Resume button there).
  resumeNumber?: number;
}) {
  const { openTerminal } = useTerminal();
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
          return (
            <li
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-md border p-3 text-sm"
            >
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
            </li>
          );
        })}
      </ul>
    </section>
  );
}
