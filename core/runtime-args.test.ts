import { expect, test } from "vitest";
import { buildRuntimeArgs, buildRuntimeFlags } from "./runtime-args.ts";

test("Cursor launch argv disables every interactive approval boundary", () => {
  const input = {
    runtime: "cursor" as const,
    model: "auto",
    prompt: "Implement the change.",
  };

  expect(buildRuntimeFlags(input)).toEqual([
    "--force",
    "--sandbox",
    "disabled",
    "--approve-mcps",
    "--model",
    "auto",
  ]);
  expect(buildRuntimeArgs(input)).toEqual([
    "--force",
    "--sandbox",
    "disabled",
    "--approve-mcps",
    "--model",
    "auto",
    "--print",
    "--trust",
    "--output-format",
    "json",
    "Implement the change.",
  ]);
});
