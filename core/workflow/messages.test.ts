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
      "Write all natural-language content generated for this run in English. This includes conversation outputs (plans, reports, reviews, summaries, notes, and comments) and artifacts such as issue and pull request titles and bodies, acceptance criteria, review text, and commit messages. Keep code, identifiers, commands, paths, and quoted log or error text in their original form.",
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
      "この run で生成する自然言語コンテンツは、commit message を除いてすべて日本語で書く。会話上の出力（plan、report、review、summary、note、comment）に加え、issue や pull request の title と body、acceptance criteria、review 文などの成果物も含む。section heading や定型 label など文書構造を支えるテキストは、既存の共通表記を維持する。commit message は repository convention に従い英語で書く。code、identifier、command、path、引用した log / error text は原文のまま維持する。",
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
