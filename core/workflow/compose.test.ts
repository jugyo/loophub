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

const executePointers = [
  { label: "repo", value: "me/proj" },
  { label: "issue", value: "#42" },
  { label: "pr", value: "#7" },
];

const verifyPointers = [
  { label: "repo", value: "me/proj" },
  { label: "issue", value: "#42" },
  { label: "base sha", value: "b".repeat(40) },
  { label: "head sha", value: "a".repeat(40) },
];

test("keeps contract and user prompt in separate channels", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      pointers: executePointers,
      baseBranch: "main",
      stepPrompt: "Prefer focused tests. USER-SENTINEL",
      note: "Read the issue first. NOTE-SENTINEL",
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
      pointers: verifyPointers,
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

test("renders the fixed-diff and worktree-context boundary for Verify", () => {
  const contract = renderWorkflowContract({
    template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
    step: "verify",
    worktreePath: "/tmp/worktree",
    baseBranch: "main",
  });

  expect(contract).toContain("authoritative and complete review subject");
  expect(contract).toContain(
    "surrounding source code in the worktree as review context",
  );
  expect(contract).toContain("does not expand the review subject");
  expect(contract).toMatch(
    /unrelated pre-existing\s+source issue as grounds for `request_changes`/u,
  );
});

test("Verify contract documents the deliberate pull/fixed asymmetry", () => {
  const contract = renderWorkflowContract({
    template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
    step: "verify",
    worktreePath: "/tmp/worktree",
    baseBranch: "main",
  });
  expect(contract).toContain("Why the asymmetry");
  expect(contract).toContain("intentional design choice");
  expect(contract).toContain(
    "Do not read the PR body, the PR comments, or the implementer's description",
  );
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
      pointers: executePointers,
      baseBranch: "main",
      stepPrompt: "Keep the change small.",
    },
  );

  expect(composed.systemPrompt).toContain(WORKFLOW_LANGUAGE_INSTRUCTION);
});

test("user prompt lists input pointers as label/value lines", () => {
  const composed = composeWorkflowStepPrompt({
    pointers: verifyPointers,
    baseBranch: "main",
    stepPrompt: "Review the diff.",
  });

  expect(composed.userPrompt).toContain(`- base sha: ${"b".repeat(40)}`);
  expect(composed.userPrompt).toContain(`- head sha: ${"a".repeat(40)}`);
  expect(composed.userPrompt).toContain("- issue: #42");
  expect(composed.userPrompt).not.toContain("diff --git");
});

test("parent/step contracts do not introduce slash commands", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      pointers: executePointers,
      baseBranch: "main",
      stepPrompt: "Keep the change small.",
    },
  );

  const allPromptText = `${composed.systemPrompt}\n${composed.userPrompt}`;
  expect(allPromptText).not.toMatch(/\/lh-/u);
});
