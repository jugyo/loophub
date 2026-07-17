import { expect, test } from "vitest";
import { RUNTIMES } from "./runtimes.ts";

test("grok modelSuggestions includes grok-4.5 and keeps existing models", () => {
  expect(RUNTIMES.grok.modelSuggestions).toEqual([
    "grok-code-fast-1",
    "grok-4.5",
    "grok-4",
    "grok-4-fast",
    "grok-3",
  ]);
});
