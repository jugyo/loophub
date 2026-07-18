import { describe, expect, it } from "vitest";
import { labelColorClass, labelColorIndex } from "./label-color";

describe("label-color", () => {
  it("is deterministic: same name → same index/class", () => {
    expect(labelColorIndex("bug")).toBe(labelColorIndex("bug"));
    expect(labelColorClass("ready-to-build")).toBe(
      labelColorClass("ready-to-build"),
    );
  });
});
