import { describe, expect, test } from "vitest";
import {
  type AppAgentDefaults,
  effectiveRepoAgentConfig,
  normalizeRepoAgentRuntime,
} from "./repo-agent-config.ts";

// Fixed application defaults for the resolver tests: claude-code, with per-runtime model/effort so a
// runtime-only override still yields that runtime's default model/effort.
const DEFAULTS: AppAgentDefaults = {
  runtime: "claude-code",
  model: (runtime) =>
    runtime === "codex"
      ? "gpt-5.5"
      : runtime === "grok"
        ? "grok-code-fast-1"
        : "opus",
  effort: (runtime) => (runtime === "codex" ? "high" : "medium"),
};

describe("normalizeRepoAgentRuntime", () => {
  test("passes through known runtimes", () => {
    expect(normalizeRepoAgentRuntime("claude-code")).toBe("claude-code");
    expect(normalizeRepoAgentRuntime("codex")).toBe("codex");
    expect(normalizeRepoAgentRuntime("grok")).toBe("grok");
  });
  test("collapses unset / unknown to null", () => {
    expect(normalizeRepoAgentRuntime(null)).toBeNull();
    expect(normalizeRepoAgentRuntime(undefined)).toBeNull();
    expect(normalizeRepoAgentRuntime("")).toBeNull();
    expect(normalizeRepoAgentRuntime("gpt")).toBeNull();
  });
});

describe("effectiveRepoAgentConfig", () => {
  test("override off falls back to the application defaults (values ignored)", () => {
    expect(
      effectiveRepoAgentConfig(
        { override: false, runtime: "codex", model: "custom", effort: "high" },
        DEFAULTS,
      ),
    ).toEqual({ runtime: "claude-code", model: "opus", effort: "medium" });
  });

  test("override on with all fields set wins over the defaults", () => {
    expect(
      effectiveRepoAgentConfig(
        {
          override: true,
          runtime: "codex",
          model: "gpt-5.6-sol",
          effort: "low",
        },
        DEFAULTS,
      ),
    ).toEqual({ runtime: "codex", model: "gpt-5.6-sol", effort: "low" });
  });

  test("override on with only the runtime set uses that runtime's default model/effort", () => {
    expect(
      effectiveRepoAgentConfig(
        { override: true, runtime: "codex", model: null, effort: null },
        DEFAULTS,
      ),
    ).toEqual({ runtime: "codex", model: "gpt-5.5", effort: "high" });
  });

  test("override on with no runtime keeps the default runtime but applies model/effort", () => {
    expect(
      effectiveRepoAgentConfig(
        { override: true, runtime: null, model: "sonnet", effort: "max" },
        DEFAULTS,
      ),
    ).toEqual({ runtime: "claude-code", model: "sonnet", effort: "max" });
  });

  test("blank model/effort strings fall back per field", () => {
    expect(
      effectiveRepoAgentConfig(
        { override: true, runtime: "grok", model: "  ", effort: "" },
        DEFAULTS,
      ),
    ).toEqual({ runtime: "grok", model: "grok-code-fast-1", effort: "medium" });
  });
});
