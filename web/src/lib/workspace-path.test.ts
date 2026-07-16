import { describe, expect, it } from "vitest";
import { workspacePath } from "./workspace-path";

describe("workspace paths", () => {
  it("encodes workspace names with URL-sensitive characters", () => {
    const name = "feature/a workspace#1";

    expect(workspacePath(name)).toBe("/r/w/feature%2Fa%20workspace%231");
  });
});
