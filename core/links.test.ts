import { expect, test } from "vitest";
import { parseClosingIssueNumber } from "./links.ts";

test("parseClosingIssueNumber detects GitHub-style keywords", () => {
  expect(parseClosingIssueNumber("closes #12")).toBe(12);
  expect(parseClosingIssueNumber("Fixes #3")).toBe(3);
  expect(parseClosingIssueNumber("This PR resolves #99 and more")).toBe(99);
  expect(parseClosingIssueNumber("no link here")).toBe(null);
});
