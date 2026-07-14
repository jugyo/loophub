import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  composeWorkflowLaunchPrompt,
  composeWorkflowStepPrompt,
  renderWorkflowContract,
  WORKFLOW_LANGUAGE_INSTRUCTION,
  WORKFLOW_STEPS,
} from "./compose.ts";

const CONTRACT_DIR = join(import.meta.dirname, "contracts");

test("keeps contract and user prompt in separate channels", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      inputFiles: [
        {
          path: "/tmp/runs/workflow/run-1/execute/input/task.md",
          description: "Requested outcome and acceptance criteria",
        },
      ],
      baseBranch: "main",
      stepPrompt: "Prefer focused tests. USER-SENTINEL",
      note: "Check the supplied task file. NOTE-SENTINEL",
    },
  );

  expect(composed.systemPrompt).toContain("Execute step contract");
  expect(composed.systemPrompt).not.toContain("USER-SENTINEL");
  expect(composed.systemPrompt).not.toContain("NOTE-SENTINEL");
  expect(composed.userPrompt).toContain("USER-SENTINEL");
  expect(composed.userPrompt).toContain("NOTE-SENTINEL");
});

test("keeps a Verify review-skill recommendation additive to the contract", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
      step: "verify",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      inputFiles: [
        {
          path: "/tmp/runs/workflow/run-1/verify/input/changes.diff",
          description: "Change diff pinned to abc123",
        },
      ],
      baseBranch: "main",
      stepPrompt:
        "Use the code-review skill's Standards and Spec perspectives when useful. REVIEW-SKILL-SENTINEL",
    },
  );

  expect(composed.systemPrompt).toContain(
    "authoritative and complete review subject",
  );
  expect(composed.systemPrompt).toContain(
    "If the step prompt conflicts with this contract, this contract wins.",
  );
  expect(composed.systemPrompt).not.toContain("REVIEW-SKILL-SENTINEL");
  expect(composed.userPrompt).toContain("REVIEW-SKILL-SENTINEL");
  expect(composed.userPrompt).toContain("Standards and Spec");
});

test("renders contract context into the system prompt", () => {
  const contract = renderWorkflowContract({
    template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
    step: "verify",
    worktreePath: "/tmp/worktree",
    baseBranch: "main",
  });

  expect(contract).toContain("## Workflow contract context");
  expect(contract).toContain("step: verify");
  expect(contract).toContain("worktree: /tmp/worktree");
  expect(contract).toContain("base branch: main");
  expect(contract).toContain("Verify step contract");
});

test("every rendered contract carries the issue-language instruction", () => {
  for (const step of ["parent", ...WORKFLOW_STEPS] as const) {
    const contract = renderWorkflowContract({
      template: readFileSync(join(CONTRACT_DIR, `${step}.md`), "utf8"),
      step,
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    });
    expect(contract).toContain(WORKFLOW_LANGUAGE_INSTRUCTION);
  }
});

test("launch prompt system channel carries the issue-language instruction", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      inputFiles: [
        {
          path: "/tmp/runs/workflow/run-1/execute/input/task.md",
          description: "Requested outcome and acceptance criteria",
        },
      ],
      baseBranch: "main",
      stepPrompt: "Keep the change small.",
    },
  );

  expect(composed.systemPrompt).toContain(WORKFLOW_LANGUAGE_INSTRUCTION);
});

test("user prompt lists large inputs by absolute path instead of embedding content", () => {
  const largeDiff = "diff --git a/a.ts b/a.ts\n".repeat(200);
  const composed = composeWorkflowStepPrompt({
    inputFiles: [
      {
        path: "/tmp/runs/workflow/run-1/verify/input/changes.diff",
        description: "Change diff pinned to abc123",
      },
    ],
    baseBranch: "main",
    stepPrompt: "Review the diff.",
  });

  expect(composed.userPrompt).toContain(
    "/tmp/runs/workflow/run-1/verify/input/changes.diff",
  );
  expect(composed.userPrompt).not.toContain(largeDiff);
  expect(composed.userPrompt).not.toContain("diff --git");
});

test("composed prompts do not introduce slash commands or domain identifiers", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      inputFiles: [
        {
          path: "/tmp/runs/workflow/run-1/execute/input/task.md",
          description: "Requested outcome and acceptance criteria",
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
