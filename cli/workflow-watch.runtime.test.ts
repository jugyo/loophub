import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const binDir = join(home, "bin");

beforeAll(async () => {
  mkdirSync(binDir);
  const localCli = join(process.cwd(), "cli/index.ts");
  const lh = join(binDir, "lh");
  writeFileSync(
    lh,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx ${JSON.stringify(localCli)} "$@"\n`,
  );
  chmodSync(lh, 0o755);
  S = await import("../core/store.ts");
  const repo = S.createRepo("me/workflow-runtime", process.cwd());
  const workflow = S.createWorkflow({
    name: "runtime-watch-test",
    description: "",
    executePrompt: "",
    verifyPrompt: "",
  });
  runId = S.createWorkflowRun({
    workflowId: workflow.id,
    repoId: repo.id,
    issueNumber: 1,
    prNumber: 1,
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
const codexLiveTest =
  process.env.LOOPHUB_LIVE_AGENT_RUNTIME === "codex" ? test : test.skip;
const CODEX_LONG_WATCH_MS = 35_000;

function emitRunEvent(args: string[]) {
  return spawnSync(process.execPath, [...NODE_ARGS, ...args], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
}

async function waitForAgent(
  child: ReturnType<typeof spawn>,
  output: () => { stdout: string; stderr: string },
) {
  return new Promise<number | null>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      const captured = output();
      reject(
        new Error(
          `agent runtime timed out\n${captured.stderr}\n${captured.stdout}`,
        ),
      );
    }, 180_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
}

function startedCodexCommand(line: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const event = parsed as Record<string, unknown>;
  if (event.type !== "item.started") return "";
  const item = event.item;
  if (!item || typeof item !== "object") return "";
  const command = item as Record<string, unknown>;
  return command.type === "command_execution" &&
    typeof command.command === "string"
    ? command.command
    : "";
}

liveTest(
  "the production agent runtime resumes the same parent after a background watch completes",
  async () => {
    const nonce = `parent-${crypto.randomUUID()}`;
    const command = [
      JSON.stringify(process.execPath),
      ...NODE_ARGS.map((arg) => JSON.stringify(arg)),
      "workflow",
      "watch",
      "--repo",
      "me/workflow-runtime",
      "--run",
      String(runId),
      "--since",
      "0",
      "--json",
    ].join(" ");
    const prompt = [
      `Your parent identity is ${nonce}.`,
      "Use the Bash tool once with run_in_background=true to run this exact blocking command:",
      command,
      "Do not use shell backgrounding, a pane, or another agent.",
      `After that background task completes, inspect its JSON and reply exactly: PARENT_RESUMED ${nonce} <event type>`,
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
        const result = emitRunEvent([
          "workflow",
          "turn",
          "done",
          "--repo",
          "me/workflow-runtime",
          "--run",
          String(runId),
        ]);
        if (result.status !== 0) stderr += result.stderr;
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const status = await waitForAgent(child, () => ({ stdout, stderr }));

    expect(emitted, stdout).toBe(true);
    expect(status, stderr).toBe(0);
    expect(stdout).toContain(`PARENT_RESUMED ${nonce} workflow_run.turn_done`);
  },
  190_000,
);

codexLiveTest(
  "the Codex parent waits over 30 seconds and runs the exact next command",
  async () => {
    const nonce = `codex-parent-${crypto.randomUUID()}`;
    const command = [
      JSON.stringify(process.execPath),
      ...NODE_ARGS.map((arg) => JSON.stringify(arg)),
      "workflow",
      "watch",
      "--repo",
      "me/workflow-runtime",
      "--run",
      String(runId),
      "--since",
      "0",
      "--json",
    ].join(" ");
    const prompt = [
      `Your parent identity is ${nonce}.`,
      "Run this exact blocking command with exec_command and yield_time_ms=250:",
      command,
      "If exec_command returns a session_id before completion, pass that same session_id to write_stdin with empty chars and yield_time_ms=30000 until the command completes.",
      "Do not produce a final response while either watcher is running.",
      "After the first completion, parse its stdout JSON. Pass its next_command unchanged as the cmd of a second exec_command, using the same session_id/write_stdin completion procedure if needed.",
      `Only after the second completion, reply exactly: PARENT_RESUMED ${nonce} workflow_run.turn_done NEXT_COMMAND_RAN workflow_run.escalated`,
      "Do not use shell backgrounding, detach the process, sleep, panes, another agent, retries, or fixed-interval polling.",
    ].join("\n");
    const child = spawn(
      "codex",
      [
        "exec",
        "--json",
        "--ephemeral",
        "--dangerously-bypass-approvals-and-sandbox",
        "--ignore-user-config",
        prompt,
      ],
      {
        cwd: process.cwd(),
        env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    let pending = "";
    let firstStarted = false;
    let firstStartedAt = 0;
    let firstWaitDurationMs = 0;
    let nextStarted = false;
    let expectedNextCommand = "";
    let observedNextCommand = "";
    let firstEventTimer: ReturnType<typeof setTimeout> | undefined;
    let secondEventTimer: ReturnType<typeof setTimeout> | undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const startedCommand = startedCodexCommand(line);
        if (
          !firstStarted &&
          startedCommand.includes("workflow watch") &&
          startedCommand.includes("--since 0")
        ) {
          firstStarted = true;
          firstStartedAt = Date.now();
          firstEventTimer = setTimeout(() => {
            const result = emitRunEvent([
              "workflow",
              "turn",
              "done",
              "--repo",
              "me/workflow-runtime",
              "--run",
              String(runId),
              "--json",
            ]);
            if (result.status !== 0) {
              stderr += result.stderr;
              return;
            }
            const eventId = JSON.parse(result.stdout).event_id;
            expectedNextCommand = `lh workflow watch --repo 'me/workflow-runtime' --run ${runId} --since ${eventId} --json`;
          }, CODEX_LONG_WATCH_MS);
          continue;
        }
        if (
          firstStarted &&
          !nextStarted &&
          expectedNextCommand &&
          startedCommand ===
            `/bin/zsh -lc ${JSON.stringify(expectedNextCommand)}`
        ) {
          nextStarted = true;
          firstWaitDurationMs = Date.now() - firstStartedAt;
          observedNextCommand = startedCommand;
          secondEventTimer = setTimeout(() => {
            const result = emitRunEvent([
              "workflow",
              "escalate",
              "--repo",
              "me/workflow-runtime",
              "--run",
              String(runId),
              "--reason",
              "codex live next command",
            ]);
            if (result.status !== 0) stderr += result.stderr;
          }, 750);
        }
      }
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    try {
      const status = await waitForAgent(child, () => ({ stdout, stderr }));

      expect(firstStarted, stdout).toBe(true);
      expect(nextStarted, stdout).toBe(true);
      expect(firstWaitDurationMs).toBeGreaterThanOrEqual(30_000);
      expect(observedNextCommand).toBe(
        `/bin/zsh -lc ${JSON.stringify(expectedNextCommand)}`,
      );
      expect(status, stderr).toBe(0);
      expect(stdout).toContain(
        `PARENT_RESUMED ${nonce} workflow_run.turn_done NEXT_COMMAND_RAN workflow_run.escalated`,
      );
    } finally {
      if (firstEventTimer) clearTimeout(firstEventTimer);
      if (secondEventTimer) clearTimeout(secondEventTimer);
    }
  },
  190_000,
);
