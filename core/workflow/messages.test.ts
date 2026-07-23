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
  expect(messages.languageInstruction).toBe(
    [
      "## Language",
      "",
      "Write this run's natural-language outputs (plans, reports, reviews, summaries, notes, and comments) in English. Keep code, identifiers, commands, paths, and quoted log or error text in their original form.",
    ].join("\n"),
  );
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
  expect(messages.languageInstruction).toBe(
    [
      "## 言語",
      "",
      "この run の自然言語出力(plan、report、review、summary、note、comment)は日本語で書く。code、identifier、command、path、引用した log / error text は原文のまま維持する。",
    ].join("\n"),
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
