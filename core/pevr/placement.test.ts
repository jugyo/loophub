import { expect, test } from "vitest";
import {
  placementTarget,
  renderReflection,
  renderVerdict,
} from "./placement.ts";

test("maps every artifact type to its domain placement", () => {
  expect(placementTarget("plan")).toBe("pr-body-plan");
  expect(placementTarget("execution-report")).toBe("pr-body-report");
  expect(placementTarget("verdict")).toBe("review");
  expect(placementTarget("reflection")).toBe("comment");
});

test("renders verdict reviews and structured reflection comments", () => {
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
    renderReflection({
      type: "reflection",
      went_well: ["Small seam"],
      friction: [],
      suggestions: [],
      followups: [],
    }),
  ).toContain("## PEVR reflection\n\n### Went well\n- Small seam");
});
