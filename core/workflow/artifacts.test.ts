import { expect, test } from "vitest";
import {
  parseWorkflowArtifactJson,
  validateWorkflowArtifact,
  type WorkflowArtifactViolation,
} from "./artifacts.ts";

function violationPaths(violations: WorkflowArtifactViolation[]): string[] {
  return violations.map((v) => v.path);
}

test("validates a plan artifact", () => {
  const result = validateWorkflowArtifact({
    type: "plan",
    summary: "Add the artifact validator.",
    changes: [
      {
        area: "core/workflow/artifacts.ts",
        description: "Define types and validation.",
      },
    ],
    reuse: ["Vitest"],
    out_of_scope: ["DB placement"],
    verification: "Run focused unit tests.",
  });

  expect(result).toEqual({
    ok: true,
    artifact: expect.objectContaining({ type: "plan" }),
  });
});

test("validates an execution-report artifact", () => {
  const result = validateWorkflowArtifact({
    type: "execution-report",
    summary: "- Added pure validation",
    acceptance: [
      {
        criterion: "Types and validator exist",
        met: true,
        note: "Implemented in core/workflow/artifacts.ts",
      },
    ],
    tests: [
      {
        command: "npm test -- core/workflow/artifacts.test.ts",
        passed: true,
        excerpt: "10 passed",
      },
    ],
    evidence: [
      {
        kind: "test",
        description: "Focused tests passed",
      },
      {
        kind: "screenshot",
        description: "Visual evidence",
        path: "evidence/visual.png",
      },
    ],
  });

  expect(result).toEqual({
    ok: true,
    artifact: expect.objectContaining({ type: "execution-report" }),
  });
});

test("validates verdict artifacts including pass with no findings", () => {
  const pass = validateWorkflowArtifact({
    type: "verdict",
    event: "pass",
    summary: "Looks good.",
    findings: [],
  });
  const requestChanges = validateWorkflowArtifact({
    type: "verdict",
    event: "request_changes",
    summary: "Needs one fix.",
    findings: [
      {
        file: "core/workflow/artifacts.ts",
        line: 12,
        problem: "Problem statement",
        expected: "Expected state",
      },
    ],
  });

  expect(pass).toEqual({
    ok: true,
    artifact: expect.objectContaining({ event: "pass" }),
  });
  expect(requestChanges).toEqual({
    ok: true,
    artifact: expect.objectContaining({ event: "request_changes" }),
  });
});

test("validates a reflection artifact", () => {
  const result = validateWorkflowArtifact({
    type: "reflection",
    went_well: ["The pure validator stayed isolated."],
    friction: [
      {
        what: "Schema ambiguity",
        cause: "The design intentionally leaves placement out.",
      },
    ],
    suggestions: [
      {
        target: "contract",
        text: "Keep examples aligned with the validator.",
      },
    ],
    followups: [
      {
        title: "Add placement policy",
        rationale: "Artifacts need domain projection later.",
      },
    ],
  });

  expect(result).toEqual({
    ok: true,
    artifact: expect.objectContaining({ type: "reflection" }),
  });
});

test("parses JSON before validating the artifact", () => {
  expect(
    parseWorkflowArtifactJson(
      JSON.stringify({
        type: "verdict",
        event: "pass",
        summary: "Accepted.",
        findings: [],
      }),
    ),
  ).toMatchObject({ ok: true });

  expect(parseWorkflowArtifactJson("{")).toEqual({
    ok: false,
    violations: [expect.objectContaining({ path: "$" })],
  });
});

test("enumerates missing fields, empty strings, invalid enums, and invalid array length", () => {
  const result = validateWorkflowArtifact({
    type: "execution-report",
    summary: "",
    acceptance: [],
    tests: [
      {
        command: "npm test",
        passed: true,
        excerpt: "",
      },
    ],
    evidence: [
      {
        kind: "unknown",
        description: "Bad evidence kind",
      },
    ],
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(violationPaths(result.violations)).toEqual(
      expect.arrayContaining([
        "$.summary",
        "$.acceptance",
        "$.tests[0].excerpt",
        "$.evidence[0].kind",
      ]),
    );
  }
});

test("rejects unknown fields so domain identifiers cannot be embedded", () => {
  const result = validateWorkflowArtifact({
    type: "plan",
    issue_number: 999,
    placement: "pr-body",
    summary: "Plan summary",
    changes: [{ area: "core", description: "Add validator" }],
    reuse: [],
    out_of_scope: [],
    verification: "Run tests",
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(violationPaths(result.violations)).toEqual(
      expect.arrayContaining(["$.issue_number", "$.placement"]),
    );
  }
});

test("requires findings when verdict requests changes", () => {
  const result = validateWorkflowArtifact({
    type: "verdict",
    event: "request_changes",
    summary: "Changes needed.",
    findings: [],
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.violations).toContainEqual({
      path: "$.findings",
      message: "Expected at least 1 item when event is request_changes",
    });
  }
});

test("requires screenshot evidence paths and rejects unsafe path forms", () => {
  const result = validateWorkflowArtifact({
    type: "execution-report",
    summary: "Summary",
    acceptance: [{ criterion: "Criterion", met: true, note: "Met" }],
    tests: [{ command: "npm test", passed: true, excerpt: "passed" }],
    evidence: [
      { kind: "screenshot", description: "Missing path" },
      {
        kind: "screenshot",
        description: "Absolute path",
        path: "/tmp/evidence.png",
      },
      {
        kind: "screenshot",
        description: "Traversal path",
        path: "../secret.png",
      },
      {
        kind: "screenshot",
        description: "Control character path",
        path: "evidence/\u0000bad.png",
      },
    ],
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(violationPaths(result.violations)).toEqual(
      expect.arrayContaining([
        "$.evidence[0].path",
        "$.evidence[1].path",
        "$.evidence[2].path",
        "$.evidence[3].path",
      ]),
    );
  }
});

test("requires reflection went_well to include at least one item", () => {
  const result = validateWorkflowArtifact({
    type: "reflection",
    went_well: [],
    friction: [],
    suggestions: [],
    followups: [],
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.violations).toContainEqual({
      path: "$.went_well",
      message: "Expected at least 1 item",
    });
  }
});
