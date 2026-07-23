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
import { workflowMessages } from "./messages.ts";

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
    "en",
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
    "en",
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
  const contract = renderWorkflowContract(
    {
      template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
      step: "verify",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    "en",
  );

  expect(contract).toContain("## Workflow contract context");
  expect(contract).toContain("step: verify");
  expect(contract).toContain("worktree: /tmp/worktree");
  expect(contract).toContain("base branch: main");
  expect(contract).toContain("Verify step contract");
});

test("the English contract wrapper remains byte-identical", () => {
  expect(
    renderWorkflowContract(
      {
        template: "# Contract\n{{step}} {{worktreePath}} {{baseBranch}}",
        step: "execute",
        worktreePath: "/tmp/worktree",
        baseBranch: "main",
      },
      "en",
    ),
  ).toBe(
    [
      "## Workflow contract context",
      "step: execute",
      "worktree: /tmp/worktree",
      "base branch: main",
      "",
      "## Language",
      "",
      "Write this run's natural-language outputs (plans, reports, reviews, summaries, notes, and comments) in English. Keep code, identifiers, commands, paths, and quoted log or error text in their original form.",
      "",
      "# Contract",
      "execute /tmp/worktree main",
    ].join("\n"),
  );
});

test("renders the fixed-diff and worktree-context boundary for Verify", () => {
  const contract = renderWorkflowContract(
    {
      template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
      step: "verify",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    "en",
  );

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
  const contract = renderWorkflowContract(
    {
      template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
      step: "verify",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    "en",
  );
  expect(contract).toContain("Why the asymmetry");
  expect(contract).toContain("intentional design choice");
  expect(contract).toContain(
    "Do not read the PR body, the PR comments, or the implementer's description",
  );
});

test("every rendered contract carries the configured-language instruction", () => {
  for (const language of ["en", "ja"] as const) {
    for (const step of ["parent", ...WORKFLOW_STEPS] as const) {
      const suffix = language === "ja" ? ".ja" : "";
      const contract = renderWorkflowContract(
        {
          template: readFileSync(
            join(CONTRACT_DIR, `${step}${suffix}.md`),
            "utf8",
          ),
          step,
          worktreePath: "/tmp/worktree",
          baseBranch: "main",
        },
        language,
      );
      expect(contract).toContain(
        workflowMessages(language).languageInstruction,
      );
    }
  }
});

test("launch prompt system channel carries the configured-language instruction", () => {
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
    "en",
  );

  expect(composed.systemPrompt).toContain(WORKFLOW_LANGUAGE_INSTRUCTION);
});

test("user prompt lists input pointers as label/value lines", () => {
  const composed = composeWorkflowStepPrompt(
    {
      pointers: verifyPointers,
      baseBranch: "main",
      stepPrompt: "Review the diff.",
    },
    "en",
  );

  expect(composed.userPrompt).toContain(`- base sha: ${"b".repeat(40)}`);
  expect(composed.userPrompt).toContain(`- head sha: ${"a".repeat(40)}`);
  expect(composed.userPrompt).toContain("- issue: #42");
  expect(composed.userPrompt).not.toContain("diff --git");
});

test("the English step prompt remains byte-identical", () => {
  expect(
    composeWorkflowStepPrompt(
      {
        pointers: executePointers,
        worktreePath: ".",
        baseBranch: "main",
        note: "Read the issue first.",
      },
      "en",
    ).userPrompt,
  ).toBe(
    [
      "## Inputs",
      "- repo: me/proj",
      "- issue: #42",
      "- pr: #7",
      "worktree: . (cwd. base branch: main)",
      "",
      "## Step prompt (user-configured)",
      "(none - follow the contract)",
      "",
      "## Note from the workflow agent",
      "Read the issue first.",
      "",
    ].join("\n"),
  );
});

test("the Japanese run composes translated contract and step prompt wrappers", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.ja.md"), "utf8"),
      step: "execute",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    {
      pointers: executePointers,
      worktreePath: ".",
      baseBranch: "main",
      note: "Issue を先に読んでください。",
    },
    "ja",
  );

  expect(composed.systemPrompt).toContain("## Workflow contract コンテキスト");
  expect(composed.systemPrompt).toContain("## 言語");
  expect(composed.systemPrompt).toContain("# Execute ステップ contract");
  expect(composed.userPrompt).toBe(
    [
      "## 入力",
      "- repo: me/proj",
      "- issue: #42",
      "- pr: #7",
      "worktree: . (cwd。base branch: main)",
      "",
      "## Step prompt（ユーザー設定）",
      "(none - contract に従ってください)",
      "",
      "## Workflow agent からの note",
      "Issue を先に読んでください。",
      "",
    ].join("\n"),
  );
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
    "en",
  );

  const allPromptText = `${composed.systemPrompt}\n${composed.userPrompt}`;
  expect(allPromptText).not.toMatch(/\/lh-/u);
});
