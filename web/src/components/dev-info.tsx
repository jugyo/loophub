// "Develop" footer for the issue/PR description card. It surfaces the commands to
// start (issue) or resume (PR) an agent dev session. This is incidental info, so it
// renders as a footer of the description card — divided by a border-t and set on a
// slightly stronger muted background — per web/DESIGN.md. It must read as part of
// the description block, not compete with it, and must not push the action buttons
// away from the card. The parent owns the card border/radius (overflow-hidden); this
// section is intentionally square-cornered.
//
// Commands use the fully-qualified `owner/repo/<id>` form so they are copy-pasteable
// from anywhere (both `lh dev` and `lh resume` accept it — see cli/index.ts usage).

import { Terminal } from "lucide-react";
import { CopyButton } from "@/components/copy-button";

type DevInfoCommand = {
  label: string;
  command: string;
  note?: string;
};

function DevInfo({ commands }: { commands: DevInfoCommand[] }) {
  return (
    <section className="flex flex-col gap-2.5 border-t bg-muted/60 px-4 py-3">
      <h2 className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Terminal className="size-3.5" />
        Develop
      </h2>
      <dl className="flex flex-col gap-2.5">
        {commands.map((c) => (
          <div key={c.command} className="flex flex-col gap-1">
            <dt className="text-xs text-muted-foreground">{c.label}</dt>
            <dd className="flex items-center gap-1">
              <code className="block w-fit max-w-full overflow-x-auto rounded border bg-background px-2.5 py-1 text-xs">
                {c.command}
              </code>
              <CopyButton value={c.command} label={`Copy: ${c.command}`} />
            </dd>
            {c.note ? (
              <p className="text-[11px] text-muted-foreground">{c.note}</p>
            ) : null}
          </div>
        ))}
      </dl>
    </section>
  );
}

// Issue: how to begin (or resume) work on this issue.
export function IssueDevInfo({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const id = `${owner}/${repo}/${number}`;
  return (
    <DevInfo
      commands={[
        { label: "Start or resume a dev session", command: `lh dev ${id}` },
        {
          label: "AFK (sandboxed, auto mode)",
          command: `lh dev --sandbox ${id}`,
          note: "Only --sandbox runs the agent unattended in auto mode.",
        },
      ]}
    />
  );
}

// PR: how to pick the dev session back up where it left off. The header's Resume button (#276) is
// the one-click path (it runs this same command in the built-in terminal, shown only when resume is
// actually possible); this copy command stays as the always-present, copy-paste-anywhere reference —
// mirroring how the issue keeps its `lh dev` copy command alongside the Build button.
export function PullDevInfo({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const id = `${owner}/${repo}/${number}`;
  return (
    <DevInfo
      commands={[
        { label: "Resume the dev session", command: `lh resume ${id}` },
      ]}
    />
  );
}
