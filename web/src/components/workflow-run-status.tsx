// Workflow run state section for issue / PR detail (#1008). Shows the display state of the run linked
// to an issue / PR: workflow name, status, current step (as a Plan → Execute → Verify → Reflect
// tracker), and rework count. The run row is the display-state source (docs/workflow.ja.md
// §5.2) — this deliberately does not re-derive step-completion truth (that stays with
// `workflow step status` / artifact placement).
//
// - blocked: surfaces the human-readable reason (latest verdict summary when present) plus links to
//   the issue (where the parent files its escalation comment, §8.4) and the Inbox.
// - completed: states that the run reached Reflect and finished.
//
// Renders nothing when the issue / PR has no run.

import { Link } from "@tanstack/react-router";
import type { WorkflowRunState } from "@/api/types";
import type { BadgeProps } from "@/components/ui/badge";
import { Badge } from "@/components/ui/badge";

const STEP_ORDER = ["plan", "execute", "verify", "reflect"] as const;
type WorkflowStep = (typeof STEP_ORDER)[number];

const STEP_LABELS: Record<WorkflowStep, string> = {
  plan: "Plan",
  execute: "Execute",
  verify: "Verify",
  reflect: "Reflect",
};

const STATUS_META: Record<
  string,
  { label: string; tone: NonNullable<BadgeProps["tone"]> }
> = {
  running: { label: "Running", tone: "working" },
  blocked: { label: "Blocked", tone: "cost-stopped" },
  completed: { label: "Completed", tone: "review-passed" },
  stopped: { label: "Stopped", tone: "closed" },
};

function isStep(value: string): value is WorkflowStep {
  return (STEP_ORDER as readonly string[]).includes(value);
}

export function WorkflowRunStatusSection({
  owner,
  repo,
  state,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState | null | undefined;
}) {
  if (!state) return null;

  const status = STATUS_META[state.status] ?? {
    label: state.status,
    tone: "unknown" as const,
  };
  const currentIndex = isStep(state.current_step)
    ? STEP_ORDER.indexOf(state.current_step)
    : -1;
  const completed = state.status === "completed";

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium text-muted-foreground">
        Workflow run
      </h2>
      <div className="flex flex-col gap-3 rounded-md border bg-muted/30 p-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Badge tone={status.tone}>{status.label}</Badge>
          <span className="font-medium">
            {state.workflow_name ?? "workflow"}
          </span>
          <span className="text-muted-foreground">run #{state.id}</span>
          {state.rework_count > 0 ? (
            <span className="text-muted-foreground">
              · rework ×{state.rework_count}
            </span>
          ) : null}
        </div>

        <StepTracker
          currentIndex={currentIndex}
          currentStep={state.current_step}
          completed={completed}
        />

        {completed ? (
          <p className="text-sm text-muted-foreground">
            {state.current_step === "reflect"
              ? "Reflect complete — the Workflow run finished all steps."
              : "The Workflow run is completed."}
          </p>
        ) : null}

        {state.status === "blocked" ? (
          <BlockedNotice owner={owner} repo={repo} state={state} />
        ) : null}
      </div>
    </section>
  );
}

// The four fixed Workflow steps in order, highlighting the run's current step. This reflects the run
// row's current_step only — it is not a claim that earlier steps are "complete" (that truth lives
// in `workflow step status`), so steps before the current one are shown as passed-through, not
// verified-done. A completed run marks steps up to and including current_step as past (normally
// Reflect, so all four); it does not force later steps to "done" if the run row completed earlier.
function StepTracker({
  currentIndex,
  currentStep,
  completed,
}: {
  currentIndex: number;
  currentStep: string;
  completed: boolean;
}) {
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-xs">
      {STEP_ORDER.map((step, index) => {
        const isCurrent = !completed && index === currentIndex;
        const isPast =
          currentIndex >= 0 &&
          (completed ? index <= currentIndex : index < currentIndex);
        return (
          <li key={step} className="flex items-center gap-1.5">
            <span
              className={
                isCurrent
                  ? "rounded-full border border-primary-border bg-primary-subtle px-2 py-0.5 font-medium text-link"
                  : isPast
                    ? "rounded-full border border-border px-2 py-0.5 text-foreground"
                    : "rounded-full border border-border px-2 py-0.5 text-muted-foreground"
              }
              aria-current={isCurrent ? "step" : undefined}
            >
              {STEP_LABELS[step]}
            </span>
            {index < STEP_ORDER.length - 1 ? (
              <span className="text-muted-foreground">→</span>
            ) : null}
          </li>
        );
      })}
      {currentIndex < 0 && !completed ? (
        <li className="text-muted-foreground">({currentStep})</li>
      ) : null}
    </ol>
  );
}

// Blocked means the parent escalated to a human (§8.4): it filed an issue comment summarizing the
// situation and sent an Inbox notification, then stopped. Point the human at both, and surface the
// latest verdict summary when one exists as the machine-readable reason behind the stall.
function BlockedNotice({
  owner,
  repo,
  state,
}: {
  owner: string;
  repo: string;
  state: WorkflowRunState;
}) {
  const verdict = state.latest_verdict;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <p className="font-medium text-amber-700 dark:text-amber-300">
        This run is blocked and needs a human.
      </p>
      {verdict && verdict.event === "request_changes" ? (
        <p className="text-muted-foreground">
          Latest verdict requested changes
          {verdict.findings_count > 0
            ? ` (${verdict.findings_count} finding${
                verdict.findings_count === 1 ? "" : "s"
              })`
            : ""}
          : {verdict.summary}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-3">
        <Link
          to="/r/$owner/$repo/issues/$number"
          params={{ owner, repo, number: String(state.issue_number) }}
          className="text-link hover:underline"
        >
          Read issue #{state.issue_number}
        </Link>
        <Link to="/inbox" className="text-link hover:underline">
          Open Inbox
        </Link>
      </div>
    </div>
  );
}
