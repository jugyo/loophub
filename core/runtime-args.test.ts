import { expect, test } from "vitest";
import { buildRuntimeArgs, buildRuntimeFlags } from "./runtime-args.ts";

test("OpenCode launch argv uses --auto, --model, and --prompt (no --variant)", () => {
  const input = {
    runtime: "opencode" as const,
    model: "opencode/big-pickle",
    // Effort is intentionally ignored: `--variant` is `opencode run`-only and kills the TUI.
    effort: "high",
    prompt: "Implement the change.",
  };

  // Flags end with --prompt so herdr's agentCommandLine `"$(cat …)"` becomes the value.
  expect(buildRuntimeFlags(input)).toEqual([
    "--auto",
    "--model",
    "opencode/big-pickle",
    "--prompt",
  ]);
  expect(buildRuntimeArgs(input)).toEqual([
    "--auto",
    "--model",
    "opencode/big-pickle",
    "--prompt",
    "Implement the change.",
  ]);
  expect(buildRuntimeFlags(input).join(" ")).not.toContain("--variant");
});

test("OpenCode omits --model when unset and still takes --prompt", () => {
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
