import { expect, test } from "vitest";
import { workflowMessages } from "./messages.ts";

test("the English workflow message catalog preserves every composed fixed phrase", () => {
  const messages = workflowMessages("en");

  expect(
    messages.contractContext({
      step: "verify",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    }),
  ).toEqual([
    "## Workflow contract context",
    "step: verify",
    "worktree: /tmp/worktree",
    "base branch: main",
  ]);
  expect(messages.inputsHeading).toBe("## Inputs");
  expect(messages.stepPromptHeading).toBe("## Step prompt (user-configured)");
  expect(messages.workflowAgentNoteHeading).toBe(
    "## Note from the workflow agent",
  );
  expect(messages.noneStepPrompt).toBe("(none - follow the contract)");
  expect(messages.reviewSubmissionInstruction).toBe("do not read the PR");
  expect(messages.handoffLaunchIntro("execute", 42)).toBe(
    "Launch Workflow execute step for run #42.",
  );
  expect(messages.handoffParentNoteHeading).toBe("## Note from parent");
  expect(messages.handoffSummary("verify")).toBe("Launch verify step");
});

test("the Japanese workflow message catalog translates prose and preserves structured terms", () => {
  const messages = workflowMessages("ja");

  expect(
    messages.contractContext({
      step: "verify",
      worktreePath: "/tmp/worktree",
      baseBranch: "main",
    }),
  ).toEqual([
    "## Workflow contract コンテキスト",
    "step: verify",
    "worktree: /tmp/worktree",
    "base branch: main",
  ]);
  expect(messages.languageInstruction).toContain("## 言語");
  expect(messages.languageInstruction).toContain(
    "code、identifier、command、path",
  );
  expect(messages.inputsHeading).toBe("## 入力");
  expect(messages.stepPromptHeading).toBe("## Step prompt（ユーザー設定）");
  expect(messages.workflowAgentNoteHeading).toBe(
    "## Workflow agent からの note",
  );
  expect(messages.noneStepPrompt).toBe("(none - contract に従ってください)");
  expect(messages.reviewSubmissionInstruction).toBe("do not read the PR");
  expect(messages.handoffLaunchIntro("execute", 42)).toBe(
    "Workflow execute step を run #42 向けに起動します。",
  );
  expect(messages.handoffParentNoteHeading).toBe("## Parent からの note");
  expect(messages.handoffSummary("verify")).toBe("verify step を起動");
});
