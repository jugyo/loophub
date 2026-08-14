import { describe, expect, test } from "vitest";
import { isServiceError } from "../errors.ts";
import {
  parseWorkflowManifest,
  serializeWorkflowManifest,
  type WorkflowManifest,
} from "./manifest.ts";

const manifest: WorkflowManifest = {
  manifest_version: 1,
  contract_language: "ja",
  agents: {
    parent: { runtime: "codex", model: "gpt-5.6-luna", effort: "high" },
    execute: { runtime: "codex", model: "gpt-5.6-luna", effort: "" },
    verify: { runtime: "codex", model: "gpt-5.6-luna", effort: "medium" },
  },
  prompts: {
    execute: "execute-step-prompt.md",
    verify: "verify-step-prompt.md",
  },
};

function expectInvalid(input: unknown, message: string): void {
  try {
    parseWorkflowManifest(
      typeof input === "string" ? input : JSON.stringify(input),
    );
    expect.fail("manifest が無効なのに parse に成功しました");
  } catch (error) {
    expect(isServiceError(error)).toBe(true);
    expect(error).toMatchObject({ status: 422 });
    expect((error as Error).message).toContain(message);
  }
}

describe("workflow manifest", () => {
  test("正常な manifest を round-trip できる", () => {
    expect(parseWorkflowManifest(serializeWorkflowManifest(manifest))).toEqual(
      manifest,
    );
  });

  test("入力オブジェクトの挿入順にかかわらず key 順を固定する", () => {
    const reversed = {
      prompts: {
        verify: manifest.prompts.verify,
        execute: manifest.prompts.execute,
      },
      agents: {
        verify: {
          effort: manifest.agents.verify.effort,
          model: manifest.agents.verify.model,
          runtime: manifest.agents.verify.runtime,
        },
        execute: {
          effort: manifest.agents.execute.effort,
          model: manifest.agents.execute.model,
          runtime: manifest.agents.execute.runtime,
        },
        parent: {
          effort: manifest.agents.parent.effort,
          model: manifest.agents.parent.model,
          runtime: manifest.agents.parent.runtime,
        },
      },
      contract_language: manifest.contract_language,
      manifest_version: manifest.manifest_version,
    } as WorkflowManifest;

    expect(serializeWorkflowManifest(reversed)).toBe(
      serializeWorkflowManifest(manifest),
    );
  });

  test.each([
    ["{", "JSON として不正"],
    [{ ...manifest, manifest_version: 2 }, "manifest_version"],
    [
      {
        ...manifest,
        agents: {
          ...manifest.agents,
          parent: { ...manifest.agents.parent, runtime: "unknown" },
        },
      },
      "未知の runtime",
    ],
    [
      {
        ...manifest,
        agents: {
          ...manifest.agents,
          verify: { ...manifest.agents.verify, runtime: "grok" },
        },
      },
      "一致",
    ],
    [
      {
        ...manifest,
        agents: {
          ...manifest.agents,
          execute: { ...manifest.agents.execute, model: "" },
        },
      },
      "model",
    ],
    [
      {
        ...manifest,
        prompts: { ...manifest.prompts, execute: "../prompt.md" },
      },
      "prompt",
    ],
    [{ ...manifest, extra: true }, "未知の key"],
  ])("不正な入力を 422 にする: %s", (input, message) => {
    expectInvalid(input, message);
  });

  test("未知の nested key も 422 にする", () => {
    expectInvalid(
      { ...manifest, prompts: { ...manifest.prompts, typo: "x.md" } },
      "未知の key",
    );
  });
});
