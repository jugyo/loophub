import type {
  WorkflowArtifact,
  WorkflowExecutionReportArtifact,
  WorkflowVerdictArtifact,
} from "./artifacts.ts";

export type WorkflowPlacementTarget = "pr-body-report" | "review";

export type WorkflowPlacementResult = {
  kind: WorkflowPlacementTarget;
  ref: string;
};

export type WorkflowPlacementDependencies = {
  currentDraft: boolean;
  assertOwnership(): void;
  updateBody(body: string): Promise<void>;
  readyForReview(): Promise<void>;
  createReview(
    input: ReturnType<typeof renderVerdict> & { headSha: string },
  ): Promise<string>;
  attach(path: string): string;
  record(kind: WorkflowPlacementTarget, ref: string): void;
};

export function placementTarget(
  type: WorkflowArtifact["type"],
): WorkflowPlacementTarget {
  switch (type) {
    case "execution-report":
      return "pr-body-report";
    case "verdict":
      return "review";
  }
}

export function renderExecutionReport(
  artifact: WorkflowExecutionReportArtifact,
  evidence: string[],
  closes: number,
): string {
  return [
    "## Summary",
    "",
    artifact.summary,
    "",
    "## Acceptance criteria",
    "",
    ...artifact.acceptance.map(
      (item) =>
        `- [${item.met ? "x" : " "}] ${item.criterion}${item.note ? ` — ${item.note}` : ""}`,
    ),
    "",
    "## Test plan",
    "",
    ...artifact.tests.map(
      (test) =>
        `- [${test.passed ? "x" : " "}] \`${test.command}\` — ${test.excerpt}`,
    ),
    "",
    "## Evidence",
    "",
    ...evidence,
    "",
    "## Reflection",
    "",
    "### Went well",
    ...artifact.reflection.went_well.map((item) => `- ${item}`),
    ...(artifact.reflection.friction.length
      ? [
          "",
          "### Friction",
          ...artifact.reflection.friction.map(
            (item) => `- ${item.what} — ${item.cause}`,
          ),
        ]
      : []),
    ...(artifact.reflection.suggestions.length
      ? [
          "",
          "### Suggestions",
          ...artifact.reflection.suggestions.map(
            (item) => `- **${item.target}**: ${item.text}`,
          ),
        ]
      : []),
    ...(artifact.reflection.followups.length
      ? [
          "",
          "### Follow-ups",
          ...artifact.reflection.followups.map(
            (item) => `- **${item.title}**: ${item.rationale}`,
          ),
        ]
      : []),
    "",
    `Closes #${closes}`,
  ].join("\n");
}

export function renderVerdict(artifact: WorkflowVerdictArtifact): {
  event: "PASS" | "REQUEST_CHANGES";
  body: string;
  comments: Array<{ path: string; line?: number; body: string }>;
} {
  return {
    event: artifact.event === "pass" ? "PASS" : "REQUEST_CHANGES",
    body: artifact.summary,
    comments: artifact.findings.map((finding) => ({
      path: finding.file,
      ...(finding.line === undefined ? {} : { line: finding.line }),
      body: `${finding.problem}\n\nExpected: ${finding.expected}`,
    })),
  };
}

export async function placeWorkflowArtifact(input: {
  artifact: WorkflowArtifact;
  headSha: string;
  issueNumber: number;
  dependencies: WorkflowPlacementDependencies;
}): Promise<WorkflowPlacementResult> {
  const { artifact, dependencies: deps } = input;
  const kind = placementTarget(artifact.type);
  let ref: string;
  switch (artifact.type) {
    case "execution-report": {
      const evidence = artifact.evidence.map((item) => {
        deps.assertOwnership();
        const embed = item.path ? deps.attach(item.path) : null;
        return `- **${item.kind}**: ${item.description}${embed ? `\n  ${embed}` : ""}`;
      });
      deps.assertOwnership();
      await deps.updateBody(
        renderExecutionReport(artifact, evidence, input.issueNumber),
      );
      if (deps.currentDraft) {
        deps.assertOwnership();
        await deps.readyForReview();
      }
      ref = "pr-body";
      break;
    }
    case "verdict":
      deps.assertOwnership();
      ref = await deps.createReview({
        ...renderVerdict(artifact),
        headSha: input.headSha,
      });
      break;
  }
  deps.assertOwnership();
  deps.record(kind, ref);
  return { kind, ref };
}
