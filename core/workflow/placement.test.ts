import { expect, test } from "vitest";
import {
  placementTarget,
  renderExecutionReport,
  renderVerdict,
} from "./placement.ts";

test("maps every artifact type to its domain placement", () => {
  expect(placementTarget("execution-report")).toBe("pr-body-report");
  expect(placementTarget("verdict")).toBe("review");
});

test("renders verdict reviews and reflection in the execution report", () => {
  expect(
    renderVerdict({
      type: "verdict",
      event: "request_changes",
      summary: "Fix this.",
      findings: [
        { file: "core/a.ts", line: 4, problem: "Wrong", expected: "Right" },
      ],
    }),
  ).toEqual({
    event: "REQUEST_CHANGES",
    body: "Fix this.",
    comments: [
      { path: "core/a.ts", line: 4, body: "Wrong\n\nExpected: Right" },
    ],
  });
  expect(
    renderExecutionReport(
      {
        type: "execution-report",
        summary: "Implemented.",
        acceptance: [{ criterion: "Works", met: true, note: "Done" }],
        tests: [{ command: "npm test", passed: true, excerpt: "1 passed" }],
        evidence: [{ kind: "test", description: "Tests passed" }],
        reflection: {
          went_well: ["Small seam"],
          friction: [],
          suggestions: [],
          followups: [],
        },
      },
      ["- **test**: Tests passed"],
      42,
    ),
  ).toContain("## Reflection\n\n### Went well\n- Small seam");
});
