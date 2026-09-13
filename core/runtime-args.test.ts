import { expect, test } from "#loophub-test";
import {
  buildRuntimeArgs,
  buildRuntimeFlags,
  runtimeLaunchEnv,
} from "./runtime-args.ts";

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

test("OpenCode 2 launch argv keeps --auto/--prompt and never carries --model", () => {
  const input = {
    runtime: "opencode2" as const,
    model: "opencode/big-pickle",
    // Effort is ignored for the same reason as OpenCode 1.
    effort: "high",
    prompt: "Implement the change.",
  };

  // `--model` is unrecognized by the opencode2 TUI (exit 1), so the model never reaches argv;
  // `--standalone` is what makes the launch's own config environment decide the model.
  expect(buildRuntimeFlags(input)).toEqual([
    "--auto",
    "--standalone",
    "--prompt",
  ]);
  expect(buildRuntimeArgs(input)).toEqual([
    "--auto",
    "--standalone",
    "--prompt",
    "Implement the change.",
  ]);
});

test("OpenCode 2 carries its model in OPENCODE_CONFIG_CONTENT", () => {
  expect(
    runtimeLaunchEnv({ runtime: "opencode2", model: "opencode/big-pickle" }),
  ).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"opencode/big-pickle"}' });
});

test("runtimeLaunchEnv is empty without a model and for flag-based runtimes", () => {
  expect(runtimeLaunchEnv({ runtime: "opencode2" })).toEqual({});
  expect(runtimeLaunchEnv({ runtime: "opencode2", model: "  " })).toEqual({});
  expect(runtimeLaunchEnv({ runtime: "opencode2", model: null })).toEqual({});
  for (const runtime of ["claude-code", "codex", "grok", "opencode"] as const) {
    expect(runtimeLaunchEnv({ runtime, model: "some-model" })).toEqual({});
  }
});

test("runtimeLaunchEnv strips control characters from the model it embeds", () => {
  expect(
    runtimeLaunchEnv({
      runtime: "opencode2",
      model: "opencode/big-pickle\u001b[31m",
    }),
  ).toEqual({ OPENCODE_CONFIG_CONTENT: '{"model":"opencode/big-pickle"}' });
});
