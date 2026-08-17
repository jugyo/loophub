export const WORKFLOW_COMMENT_TARGETS = [
  "executor",
  "verifier",
  "orchestrator",
] as const;

export type WorkflowCommentTarget = (typeof WORKFLOW_COMMENT_TARGETS)[number];

const TARGET_BY_MENTION: Record<string, WorkflowCommentTarget> = {
  executor: "executor",
  verifier: "verifier",
  loophub: "orchestrator",
  lh: "orchestrator",
};

const WORKFLOW_MENTION =
  /(?<![A-Za-z0-9_-])@(executor|verifier|loophub|lh)(?![A-Za-z0-9_-])/gu;

/** Resolve the distinct workflow agents named across one PR feedback item. */
export function workflowCommentTargets(
  bodies: readonly string[],
): WorkflowCommentTarget[] {
  const targets = new Set<WorkflowCommentTarget>();
  for (const body of bodies) {
    for (const match of body.matchAll(WORKFLOW_MENTION)) {
      targets.add(TARGET_BY_MENTION[match[1]]!);
    }
  }
  return targets.size > 0 ? [...targets] : ["executor"];
}
