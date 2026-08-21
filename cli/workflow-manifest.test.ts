import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import {
  serializeWorkflowManifest,
  type WorkflowManifest,
} from "../core/workflow/manifest.ts";
import {
  workflowManifestPath,
  writeWorkflowManifest,
} from "../core/workflow/run-files.ts";

const home = mkdtempSync(join(tmpdir(), "lh-workflow-manifest-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

const NODE_ARGS = ["cli/index.ts"];

let S: typeof import("../core/store.ts");
let repoName: string;
let runId: number;

function runCli(args: string[]) {
  return spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    timeout: 10_000,
  });
}

const manifest: WorkflowManifest = {
  manifest_version: 1,
  contract_language: "ja",
  agents: {
    parent: { runtime: "codex", model: "gpt-test", effort: "medium" },
    execute: { runtime: "codex", model: "gpt-test", effort: "medium" },
    verify: { runtime: "codex", model: "gpt-test", effort: "medium" },
  },
  prompts: {
    execute: "execute-step-prompt.md",
    verify: "verify-step-prompt.md",
  },
};

beforeAll(async () => {
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-manifest", process.cwd());
  repoName = repo.full_name;
  const workflow = S.createWorkflow({
    name: "manifest-test",
    description: "",
    executePrompt: "execute",
    verifyPrompt: "verify",
  });
  const issue = S.createIssue(repo.id, "issue", "manifest issue", "", "me");
  const prIssue = S.createIssue(repo.id, "pull", "manifest PR", "", "me");
  S.createPull(
    prIssue.id,
    `loophub/pr-${prIssue.number}`,
    "main",
    null,
    issue.id,
  );
  runId = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: issue.number,
    prNumber: prIssue.number,
    status: "running",
    currentStep: "execute",
    costIncrementUsd: 1,
    costLimitUsd: 1,
    manifestVersion: 1,
  }).id;
  writeWorkflowManifest(runId, serializeWorkflowManifest(manifest));
});

afterAll(() => rmSync(home, { recursive: true, force: true }));

test("workflow manifest show は manifest・DB pointer・導出 workspace を表示する", () => {
  const result = runCli([
    "workflow",
    "manifest",
    "show",
    String(runId),
    "--repo",
    repoName,
  ]);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("動作条件 (manifest)");
  expect(result.stdout).toContain("pointer (DB)");
  expect(result.stdout).toContain("workspace (規約から導出)");
  expect(result.stdout).toContain("次に起動する子から反映");
  expect(result.stdout).toContain("現在の Execute child には反映されません");
});

test("workflow manifest path は絶対 manifest path だけを表示する", () => {
  const result = runCli([
    "workflow",
    "manifest",
    "path",
    String(runId),
    "--repo",
    repoName,
  ]);

  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(workflowManifestPath(runId));
});

test("workflow manifest show は JSON 出力に対応する", () => {
  const result = runCli([
    "workflow",
    "manifest",
    "show",
    String(runId),
    "--repo",
    repoName,
    "--json",
  ]);

  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    manifest_path: workflowManifestPath(runId),
    manifest: { contract_language: "ja" },
    pointers: [
      { label: "repo", value: repoName },
      { label: "issue", value: "#1" },
      { label: "pr", value: "#2" },
    ],
  });
});

test("workflow manifest show は不正な manifest を可視エラーとして拒否する", () => {
  writeWorkflowManifest(runId, '{"manifest_version":1}\n');
  const result = runCli([
    "workflow",
    "manifest",
    "show",
    String(runId),
    "--repo",
    repoName,
  ]);

  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("workflow manifest");
  expect(result.stderr).toContain("is invalid");
});
