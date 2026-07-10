import type {
  PevrArtifact,
  PevrExecutionReportArtifact,
  PevrVerdictArtifact,
} from "./artifacts.ts";

export type PevrPlacementTarget =
  | "pr-body-plan"
  | "pr-body-report"
  | "review"
  | "comment";

export type PevrPlacementResult = { kind: PevrPlacementTarget; ref: string };

export type PevrPlacementDependencies = {
  currentBody: string;
  currentDraft: boolean;
  assertOwnership(): void;
  updateBody(body: string): Promise<void>;
  readyForReview(): Promise<void>;
  createReview(
    input: ReturnType<typeof renderVerdict> & { headSha: string },
  ): Promise<string>;
  createComment(body: string): Promise<string>;
  attach(path: string): string;
  record(kind: PevrPlacementTarget, ref: string): void;
};

export function placementTarget(
  type: PevrArtifact["type"],
): PevrPlacementTarget {
  switch (type) {
    case "plan":
      return "pr-body-plan";
    case "execution-report":
      return "pr-body-report";
    case "verdict":
      return "review";
    case "reflection":
      return "comment";
  }
}

export function renderPlanBody(
  current: string,
  artifact: Extract<PevrArtifact, { type: "plan" }>,
): string {
  const plan = [
    "## Implementation plan",
    "",
    artifact.summary,
    "",
    ...artifact.changes.map(
      (change) => `- **${change.area}**: ${change.description}`,
    ),
    ...(artifact.reuse.length
      ? ["", "### Reuse", "", ...artifact.reuse.map((item) => `- ${item}`)]
      : []),
    ...(artifact.out_of_scope.length
      ? [
          "",
          "### Out of scope",
          "",
          ...artifact.out_of_scope.map((item) => `- ${item}`),
        ]
      : []),
    "",
    `### Verification\n\n${artifact.verification}`,
  ].join("\n");
  const marker =
    /^## (?:Implementation plan|実装計画)[\s\S]*?(?=^## |$(?![\s\S]))/mu;
  return marker.test(current)
    ? current.replace(marker, `${plan}\n\n`)
    : `${plan}\n\n${current}`;
}

export function renderExecutionReport(
  artifact: PevrExecutionReportArtifact,
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
    `Closes #${closes}`,
  ].join("\n");
}

export function renderVerdict(artifact: PevrVerdictArtifact): {
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

export function renderReflection(
  artifact: Extract<PevrArtifact, { type: "reflection" }>,
): string {
  return [
    "## PEVR reflection",
    "",
    "### Went well",
    ...artifact.went_well.map((item) => `- ${item}`),
    ...(artifact.friction.length
      ? [
          "",
          "### Friction",
          ...artifact.friction.map((item) => `- ${item.what} — ${item.cause}`),
        ]
      : []),
    ...(artifact.suggestions.length
      ? [
          "",
          "### Suggestions",
          ...artifact.suggestions.map(
            (item) => `- **${item.target}**: ${item.text}`,
          ),
        ]
      : []),
    ...(artifact.followups.length
      ? [
          "",
          "### Follow-ups",
          ...artifact.followups.map(
            (item) => `- **${item.title}**: ${item.rationale}`,
          ),
        ]
      : []),
  ].join("\n");
}

export async function placePevrArtifact(input: {
  artifact: PevrArtifact;
  headSha: string;
  issueNumber: number;
  dependencies: PevrPlacementDependencies;
}): Promise<PevrPlacementResult> {
  const { artifact, dependencies: deps } = input;
  const kind = placementTarget(artifact.type);
  let ref: string;
  switch (artifact.type) {
    case "plan":
      deps.assertOwnership();
      await deps.updateBody(renderPlanBody(deps.currentBody, artifact));
      ref = "pr-body";
      break;
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
    case "reflection":
      deps.assertOwnership();
      ref = await deps.createComment(renderReflection(artifact));
      break;
  }
  deps.assertOwnership();
  deps.record(kind, ref);
  return { kind, ref };
}
