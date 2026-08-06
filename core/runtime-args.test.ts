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

test("OpenCode launch argv uses --auto, --model, --variant, and --prompt", () => {
  const input = {
    runtime: "opencode" as const,
    model: "opencode/big-pickle",
    effort: "high",
    prompt: "Implement the change.",
  };

  // Flags end with --prompt so herdr's agentCommandLine `"$(cat …)"` becomes the value.
  expect(buildRuntimeFlags(input)).toEqual([
    "--auto",
    "--model",
    "opencode/big-pickle",
    "--variant",
    "high",
    "--prompt",
  ]);
  expect(buildRuntimeArgs(input)).toEqual([
    "--auto",
    "--model",
    "opencode/big-pickle",
    "--variant",
    "high",
    "--prompt",
    "Implement the change.",
  ]);
});

test("OpenCode omits --model/--variant when unset and still takes --prompt", () => {
  const input = {
    runtime: "opencode" as const,
    prompt: "Create an issue.",
  };
  expect(buildRuntimeFlags(input)).toEqual(["--auto", "--prompt"]);
  expect(buildRuntimeArgs(input)).toEqual([
    "--auto",
    "--prompt",
    "Create an issue.",
  ]);
});
