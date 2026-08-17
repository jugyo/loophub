import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  composeWorkflowLaunchPrompt,
  composeWorkflowStepPrompt,
  renderWorkflowContract,
  WORKFLOW_STEPS,
} from "./compose.ts";
import { workflowMessages } from "./messages.ts";

const CONTRACT_DIR = join(import.meta.dirname, "contracts");

const executePointers = [
  { label: "repo", value: "me/proj" },
  { label: "run", value: "7" },
  { label: "issue", value: "#42" },
  { label: "pr", value: "#7" },
];

const verifyPointers = [
  { label: "repo", value: "me/proj" },
  { label: "run", value: "7" },
  { label: "issue", value: "#42" },
  { label: "base sha", value: "b".repeat(40) },
  { label: "head sha", value: "a".repeat(40) },
];

test("keeps contract and user prompt in separate channels", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      repo: "me/proj",
      step: "execute",
      run: 7,
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

test("keeps a Verify step prompt additive to the contract", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "verify.md"), "utf8"),
      repo: "me/proj",
      step: "verify",
      run: 7,
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

  expect(composed.systemPrompt).not.toContain("REVIEW-SKILL-SENTINEL");
  expect(composed.userPrompt).toContain("REVIEW-SKILL-SENTINEL");
  expect(composed.userPrompt).toContain("Standards and Spec");
});

test("renders contract inputs and template placeholders into the system prompt", () => {
  const contract = renderWorkflowContract(
    {
      template:
        "REPO={{repo}} STEP={{step}} RUN={{run}} WORKTREE={{worktreePath}} BASE={{baseBranch}}",
      repo: "me/proj",
      step: "verify",
      run: 56,
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    "en",
  );

  expect(contract).toContain("step: verify");
  expect(contract).toContain("worktree: /tmp/worktree");
  expect(contract).toContain("base branch: main");
  expect(contract).toContain(
    "REPO='me/proj' STEP=verify RUN=56 WORKTREE=/tmp/worktree BASE=main",
  );
});

test("shell-quotes repo placeholders without re-expanding their value", () => {
  const contract = renderWorkflowContract(
    {
      template: "REPO={{repo}} RUN={{run}}",
      repo: "me/it's-{{run}}",
      step: "execute",
      run: 56,
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    },
    "en",
  );

  expect(contract).toContain(`REPO='me/it'\\''s-{{run}}' RUN=56`);
  expect(contract).not.toContain("me/it's-56");
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
          repo: "me/proj",
          step,
          run: 7,
          worktreePath: "/tmp/worktree",
          baseBranch: "main",
        },
        language,
      );
      expect(contract).toContain(
        workflowMessages(language).languageInstruction,
      );
      expect(contract).not.toContain("{{repo}}");
      expect(contract).toContain("--repo 'me/proj'");
      expect(contract).toContain(
        language === "en"
          ? "pull request titles and bodies"
          : "pull request の title と body",
      );
      expect(contract).toContain(
        language === "en"
          ? "quoted log or error text in their original form"
          : "引用した log / error text は原文のまま維持する",
      );
      if (language === "ja") {
        expect(contract).toContain(
          "section heading や定型 label など文書構造を支えるテキストは、既存の共通表記を維持する",
        );
        expect(contract).toContain(
          "review 文、commit message などの成果物も含む",
        );
        expect(contract).toContain(
          "対象 repository が commit message の言語規約を明記している場合は、その規約を優先する",
        );
        // The positive assertions above still pass if an exclusion clause is added back
        // alongside them, and such a clause has two independent shapes: carving commit
        // messages out of the Japanese set, and naming the language they take instead.
        expect(contract).not.toContain("commit message を除いて");
        expect(contract).not.toContain("英語");
      }
    }
  }
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

test("step prompt composition preserves structured inputs and optional text", () => {
  for (const language of ["en", "ja"] as const) {
    const composed = composeWorkflowStepPrompt(
      {
        pointers: executePointers,
        worktreePath: ".",
        baseBranch: "main",
        stepPrompt: "  Keep the change small.  ",
        note: "  Read the issue first.  ",
      },
      language,
    );

    expect(composed.pointers).toEqual(executePointers);
    expect(composed.stepPrompt).toBe("Keep the change small.");
    expect(composed.note).toBe("Read the issue first.");
    expect(composed.userPrompt).toContain("- repo: me/proj");
    expect(composed.userPrompt).toContain("- issue: #42");
    expect(composed.userPrompt).toContain("- pr: #7");
    expect(composed.userPrompt).toContain("worktree: .");
    expect(composed.userPrompt).toContain("base branch: main");
  }
});

test("parent/step contracts do not introduce slash commands", () => {
  const composed = composeWorkflowLaunchPrompt(
    {
      template: readFileSync(join(CONTRACT_DIR, "execute.md"), "utf8"),
      repo: "me/proj",
      step: "execute",
      run: 7,
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
  expect(allPromptText).not.toMatch(/\/lh-[a-z]/u);
});
