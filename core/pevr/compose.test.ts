import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  composePevrLaunchPrompt,
  composePevrStepPrompt,
  renderPevrContract,
} from "./compose.ts";

const CONTRACT_DIR = join(import.meta.dirname, "contracts");

test("keeps contract and user prompt in separate channels", () => {
  const composed = composePevrLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "plan.md"), "utf8"),
      step: "plan",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      inputFiles: [
        {
          path: "/tmp/runs/pevr/run-1/plan/input/task.md",
          description: "Requested outcome and acceptance criteria",
        },
      ],
      baseBranch: "main",
      stepPrompt: "Prefer focused tests. USER-SENTINEL",
      note: "Check the supplied task file. NOTE-SENTINEL",
    },
  );

  expect(composed.systemPrompt).toContain("Plan step contract");
  expect(composed.systemPrompt).not.toContain("USER-SENTINEL");
  expect(composed.systemPrompt).not.toContain("NOTE-SENTINEL");
  expect(composed.userPrompt).toContain("USER-SENTINEL");
  expect(composed.userPrompt).toContain("NOTE-SENTINEL");
});

test("renders contract context into the system prompt", () => {
  const contract = renderPevrContract({
    template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
    step: "verify",
    worktreePath: "/tmp/worktree",
    baseBranch: "main",
  });

  expect(contract).toContain("## PEVR contract context");
  expect(contract).toContain("step: verify");
  expect(contract).toContain("worktree: /tmp/worktree");
  expect(contract).toContain("base branch: main");
  expect(contract).toContain("Verify step contract");
});

test("user prompt lists large inputs by absolute path instead of embedding content", () => {
  const largeDiff = "diff --git a/a.ts b/a.ts\n".repeat(200);
  const composed = composePevrStepPrompt({
    inputFiles: [
      {
        path: "/tmp/runs/pevr/run-1/verify/input/changes.diff",
        description: "Change diff pinned to abc123",
      },
    ],
    baseBranch: "main",
    stepPrompt: "Review the diff.",
  });

  expect(composed.userPrompt).toContain(
    "/tmp/runs/pevr/run-1/verify/input/changes.diff",
  );
  expect(composed.userPrompt).not.toContain(largeDiff);
  expect(composed.userPrompt).not.toContain("diff --git");
});

test("composed prompts do not introduce slash commands or domain identifiers", () => {
  const composed = composePevrLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      inputFiles: [
        {
          path: "/tmp/runs/pevr/run-1/execute/input/task.md",
          description: "Requested outcome and acceptance criteria",
        },
        {
          path: "/tmp/runs/pevr/run-1/execute/input/plan.md",
          description: "Accepted implementation plan",
        },
      ],
      baseBranch: "main",
      stepPrompt: "Keep the change small.",
    },
  );

  const allPromptText = `${composed.systemPrompt}\n${composed.userPrompt}`;
  expect(allPromptText).not.toMatch(/\/lh-/u);
  expect(allPromptText).not.toMatch(/\bissue\s*#?\d+\b/iu);
  expect(allPromptText).not.toMatch(/\bPR\s*#?\d+\b/u);
  expect(allPromptText).not.toMatch(/\brepo(?:sitory)?[:/ ]/iu);
});
