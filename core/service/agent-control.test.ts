import { describe, expect, test } from "vitest";
import { assertAgentExecutionTarget } from "./agent-control.ts";

describe("assertAgentExecutionTarget", () => {
  test("delegates Herdr target validation to the adapter boundary", () => {
    expect(() =>
      assertAgentExecutionTarget({
        provider: "herdr",
        targetId: "w1:p2",
        context: "repo-session",
      }),
    ).not.toThrow();
    expect(() =>
      assertAgentExecutionTarget({
        provider: "herdr",
        targetId: "--invalid",
        context: "repo-session",
      }),
    ).toThrowError("Agent has no valid Herdr execution target");
    expect(() =>
      assertAgentExecutionTarget({
        provider: "herdr",
        targetId: "w1:p2",
        context: null,
      }),
    ).toThrowError("Agent has no valid Herdr execution target");
  });

  test("rejects providers without an adapter", () => {
    expect(() =>
      assertAgentExecutionTarget({
        provider: "unknown",
        targetId: "target",
        context: null,
      }),
    ).toThrowError('Unsupported agent-control provider "unknown"');
  });
});
