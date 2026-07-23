import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-workflow-runtime-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "loophub.db");

const NODE_ARGS = [
  "--experimental-sqlite",
  "--disable-warning=ExperimentalWarning",
  "--import",
  "tsx",
  "cli/index.ts",
];

let S: typeof import("../core/store.ts");
let runId: number;

beforeAll(async () => {
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-runtime", process.cwd());
  const workflow = S.createWorkflow({
    name: "runtime-watch-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  const issue = S.createIssue(repo.id, "issue", "runtime", "", "me");
  const prIssue = S.createIssue(repo.id, "pull", "runtime pr", "", "me");
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
  }).id;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const liveTest =
  process.env.LOOPHUB_LIVE_AGENT_RUNTIME === "claude-code" ? test : test.skip;

liveTest(
  "the production agent runtime resumes the same parent after a background watch completes",
  async () => {
    const nonce = `parent-${crypto.randomUUID()}`;
    const command = [
      JSON.stringify(process.execPath),
      ...NODE_ARGS.map((arg) => JSON.stringify(arg)),
      "workflow",
      "next",
      String(runId),
      "--repo",
      "me/workflow-runtime",
      "--watch",
      "--json",
    ].join(" ");
    const prompt = [
      `Your parent identity is ${nonce}.`,
      "Use the Bash tool once with run_in_background=true to run this exact blocking command:",
      command,
      "Do not use shell backgrounding, a pane, or another agent.",
      `After that background task completes, inspect its JSON and reply exactly: PARENT_RESUMED ${nonce} <event.type>`,
    ].join("\n");
    const child = spawn(
      "claude",
      [
        "-p",
        "--verbose",
        "--output-format",
        "stream-json",
        "--permission-mode",
        "bypassPermissions",
        "--allowedTools",
        "Bash",
        "--",
        prompt,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let emitted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (!emitted && /run_in_background\\?"?:\s*true/.test(stdout)) {
        emitted = true;
        const result = spawnSync(
          process.execPath,
          [
            ...NODE_ARGS,
            "workflow",
            "turn",
            "done",
            "--repo",
            "me/workflow-runtime",
            "--run",
            String(runId),
          ],
          { cwd: process.cwd(), env: process.env, encoding: "utf8" },
        );
        if (result.status !== 0) stderr += result.stderr;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const status = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error(`agent runtime timed out\n${stderr}\n${stdout}`));
      }, 180_000);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timeout);
        resolve(code);
      });
    });

    expect(emitted, stdout).toBe(true);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain(`PARENT_RESUMED ${nonce} workflow_run.turn_done`);
  },
  190_000,
);
