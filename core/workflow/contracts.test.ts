import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workflowContractText, workflowStepContracts } from "./contracts.ts";

test("loads every step contract from the canonical Markdown sources", () => {
  const contracts = workflowStepContracts();

  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
});

test("loads Japanese translations for every fixed contract", () => {
  const contracts = workflowStepContracts("ja");

  expect(workflowContractText("parent", "ja")).toContain(
    "# Parent workflow contract",
  );
  expect(contracts.execute).toContain("# Execute ステップ contract");
  expect(contracts.verify).toContain("# Verify ステップ contract");
});

test("Japanese contracts preserve the required commands and decision branches", () => {
  const parent = workflowContractText("parent", "ja");
  const execute = workflowContractText("execute", "ja");
  const verify = workflowContractText("verify", "ja");

  for (const command of [
    "lh workflow run advance-to-verify",
    "lh workflow run request-rework",
    "lh workflow run activate-step",
    "lh workflow run await-human",
    "lh workflow run resume",
    "lh workflow launch-step",
    "lh workflow step status",
    "herdr agent get",
    "herdr agent list",
    "herdr pane run",
    "herdr pane send-keys",
    "lh issue comment",
    "lh inbox send",
  ]) {
    expect(parent).toContain(command);
  }
  for (const branch of [
    "workflow_run.turn_done",
    "workflow_run.review_submitted",
    "workflow_run.escalated",
    "workflow_run.github_event",
    "workflow_run.merge_conflict",
    "workflow_run.cost_exceeded",
    "request_changes",
    "FEEDBACK",
  ]) {
    expect(parent).toContain(branch);
  }
  expect(execute).toContain("lh issue view <n> --json");
  expect(execute).toContain("lh pr update <pr>");
  expect(execute).toContain("lh workflow escalate");
  expect(execute).toContain("lh workflow turn done");
  expect(verify).toContain("git diff <base sha>..<head sha>");
  expect(verify).toContain("lh pr review <pr>");
  expect(verify).toContain("--event pass|request_changes");
  expect(verify).toContain("--topic workflow");
  expect(verify).toContain("--commit <head sha>");
});

test("Execute pulls domain state itself and declares turn done", () => {
  const execute = workflowContractText("execute");

  // Repo may be inferred from a LoopHub worktree cwd (#1595); --repo is only required when
  // not inferable from cwd, or when overriding inference.
  expect(execute).toContain("lh issue view <n> --json");
  expect(execute).toContain(
    "`resolveRepo()` also infers the registered repo without `--repo`",
  );
  expect(execute).toContain("lh pr update <pr>");
  expect(execute).toContain(
    "lh workflow turn done --repo '<repo>' --run <run>",
  );
  expect(execute).toContain(
    "lh workflow escalate --repo '<repo>' --run <run> --reason <short summary>",
  );
  expect(execute).toContain("present the full concrete question");
  expect(execute).toContain("in the same pane");
  // The contract retires the artifact / step-output path by name.
  expect(execute).toContain(
    "There is no execution-report artifact and no `lh workflow step output`",
  );
});

test("Verify reviews a fixed base..head diff it computes itself", () => {
  const verify = workflowContractText("verify");

  expect(verify).toContain("git diff <base sha>..<head sha>");
  expect(verify).toContain("authoritative and complete review subject");
  expect(verify).toMatch(/do not\s+substitute/u);
  expect(verify).toContain("optional aid");
  expect(verify).toMatch(/Standards\s+and Spec/u);
  // Output is a pinned PR review, not an artifact.
  expect(verify).toContain("lh pr review <pr>");
  expect(verify).toContain("--commit <head sha>");
  expect(verify).toContain(
    "There is no verdict artifact and no `lh workflow step output`",
  );
});

test("Verify is PR-metadata-blind and documents the deliberate asymmetry", () => {
  const verify = workflowContractText("verify");

  expect(verify).toContain("Why the asymmetry");
  expect(verify).toContain("intentional design choice");
  expect(verify).toContain(
    "Do not read the PR body, PR comments, or the implementer's description",
  );
  expect(verify).toContain(
    "surrounding source code in the worktree as review context",
  );
  expect(verify).toContain("does not expand the review subject");
  expect(verify).toContain("Do not edit source files");
});

test("parent decides transitions by observation, never idle detection", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("lh workflow step status");
  expect(parent).toContain("You do **not** use idle detection");
  expect(parent).toMatch(/never treat a child\s+going idle as a signal/u);
  // The command is named only to forbid it — the run never waits on idle to transition.
  expect(parent).toContain("Do not run `herdr agent wait --status idle`");
});

test("parent delivers rework as a review-id pointer without summarizing findings", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain(
    "Do **not** summarize, quote, or interpret the review's",
  );
  expect(parent).toContain("orchestrator: address review #<id>");
  expect(parent).toContain(
    "lh workflow launch-step --repo '<repo>' --run <run> --step execute --review <id>",
  );
});

test("parent injects into live children via herdr and falls back to launch-step", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("herdr pane run");
  expect(parent).toContain("herdr agent get");
  expect(parent).toContain("herdr agent list");
  expect(parent).toContain("record the printed `agent` line");
  expect(parent).toContain("orchestrator:");
  expect(parent).toContain("lh workflow run resume");
  expect(parent).not.toContain("lh workflow run enforce-cost-limit");
  expect(parent).toMatch(
    /launch \*\*Verify as a\s+fresh child\*\* — always a new child/u,
  );
  expect(parent).toContain("Do not use child-session resume");
});

test("parent prefers same-session Execute inject for rework, continuing, and merge conflict", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("shared Execute inject path");
  expect(parent).toContain("same Execute session");
  expect(parent).toContain(
    "Do not launch a fresh Execute on rework / continuing / merge-conflict when the live Execute pane",
  );
  expect(parent).toContain(
    "Verify never reuses a prior verifier session via injection",
  );
  expect(parent).toContain(
    "hand resolution to\n  Execute via the same inject-or-launch path as continuing work",
  );
});

test("parent inject text is single-line and inject is not a transition fact", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("The text must be a single line");
  expect(parent).toContain(
    "collapse newlines, tabs, and other control characters",
  );
  expect(parent).toContain(
    "Do not inject multi-line or control-character-laden text into a pane",
  );
  expect(parent).toContain(
    "Injecting text is delivery only; it is never itself a",
  );
  expect(parent).toContain(
    "Do **not** wait for the child to go idle before injecting",
  );
});

test("parent documents inject-round audit without a new command", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("Auditing inject rounds");
  expect(parent).toContain("rework_count");
  expect(parent).toContain("step_sessions_json.execute");
  expect(parent).toContain(
    "Do not add a new lh command solely to audit inject rounds",
  );
});

test("parent polls only its run workflow events and reacts to cost limit facts", () => {
  const contract = workflowContractText("parent");

  expect(contract).toContain(
    "lh events --since <cursor> --repo '<repo>' --type workflow_run --run <run> --order asc --json",
  );
  expect(contract).not.toContain("lh subscribe --repo");
  expect(contract).toContain(
    "The `--type workflow_run --run <run>` filters are mandatory",
  );
  expect(contract).toContain("workflow_run.cost_exceeded");
  expect(contract).toContain("herdr pane send-keys <pane_id> Escape");
  expect(contract).toContain("submits\n  the literal text `Escape`");
  expect(contract).toContain("usage_session_id");
  expect(contract).toContain("active_step");
  expect(contract).toContain("active_session_id");
  expect(contract).toContain(
    "lh workflow run activate-step --repo '<repo>' --run <run> --step execute --session <session_id>",
  );
  expect(contract).toContain("Cost limit exceeded. Continue?");
  expect(contract).toContain("only **yes** and **no** choices");
  expect(contract).toContain(
    "Handle each `workflow_run.cost_exceeded` event id exactly once",
  );
  expect(contract).toContain(
    "first run `lh workflow step status <run> --repo '<repo>' --json`",
  );
  expect(contract).toContain(
    "For Verify, do not reuse the interrupted verifier",
  );
  expect(contract).toContain("leave the human hold in place");
  expect(contract).toContain(
    "do not display the pane notification or confirmation again",
  );
  expect(
    contract.indexOf("Put the run in its visible human hold"),
  ).toBeLessThan(
    contract.indexOf(
      "Send the actual key with `herdr pane send-keys <pane_id> Escape`",
    ),
  );
  expect(
    contract.indexOf(
      "Send the actual key with `herdr pane send-keys <pane_id> Escape`",
    ),
  ).toBeLessThan(contract.indexOf("After Esc succeeds, send exactly one"));
  expect(contract).toContain(
    "do not report the interrupt /\nconfirmation as successful",
  );
  expect(contract).not.toContain("lh workflow run enforce-cost-limit");
  expect(contract).not.toContain("lh workflow run stop");
  expect(contract).toContain("sleep briefly and poll again");
});

test("documents recording the launch-step agent line as the injection target", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("always starts a fresh child session");
  expect(parent).toContain("record the printed `agent` line");
  expect(parent).toContain("pane_id");
  expect(parent).toContain("Prefer live pane injection");
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowStepContracts();

  for (const contract of Object.values(contracts)) {
    expect(contract).toContain(
      "messages beginning with `orchestrator:` are instructions from the workflow",
    );
  }
});

test("parent and execute contracts agree that the parent injects orchestrator messages", () => {
  const parent = workflowContractText("parent");
  const execute = workflowContractText("execute");

  expect(execute).toContain("messages beginning with `orchestrator:`");
  expect(execute).toContain("this same live session");
  expect(execute).toContain("orchestrator: address review #<id>");
  expect(parent).toContain("orchestrator:");
  expect(parent).toContain("herdr pane run");
  expect(parent).not.toContain("Do not use herdr pane injection");
});

test("Execute treats additional work notes as Issue/PR requests and completes via turn done", () => {
  const execute = workflowContractText("execute");

  expect(execute).toContain("Follow-ups: rework vs additional work");
  expect(execute).toContain("additional request against the\nIssue or PR");
  expect(execute).toContain("human notes, continuing instructions");
  expect(execute).toContain("--note");
  expect(execute).toContain(
    "Do not invent a special completion path for additional work",
  );
  expect(execute).toContain(
    "lh workflow turn done --repo '<repo>' --run <run>",
  );
  // Rework stays distinct from free-form extension, but both end the same way.
  expect(execute).toContain("review response");
  expect(execute).toContain(
    "same commit-then-turn-done rule applies\n   to rework and to additional work",
  );
  // Narrow non-implementation edges stay compatible with parent observation.
  expect(execute).toContain("Question-only or blocked on a human decision");
  expect(execute).toContain("declare turn done **without** a commit");
  expect(execute).toContain("unchanged HEAD leaves the existing pass\nfresh");
  expect(execute).toContain("You do **not** have to rewrite the issue body");
});

test("Japanese workflow design documents the continuing lifecycle after a pass", () => {
  const design = readFileSync(
    join(import.meta.dirname, "..", "..", "docs", "workflow.ja.md"),
    "utf8",
  );

  expect(design).not.toContain("fresh pass review → run completed");
  expect(design).not.toContain("passing verdict で run を completed にする");
  expect(design).toContain("run を `running` のまま維持");
  expect(design).toContain("`run resume` は使わず");
  expect(design).toContain("`--note` 付きで Execute を launch");
  expect(design).toContain(
    "PR body・comment・attachment だけの更新は HEAD を変えない",
  );
  expect(design).toContain("`agent_status: done` でも pane は再利用可能");
  expect(design).toMatch(/修正後の Verify は常に\s+fresh child/u);
  expect(design).toContain("`stopped`（#1525）は");
  expect(design).toContain("legacy status");
  expect(design).not.toContain("lh workflow run enforce-cost-limit");
  expect(design).toContain("herdr pane run");
  expect(design).toContain("herdr agent list");
  expect(design).toContain(
    "rework / 継続作業は同じ Execute セッションを優先する",
  );
  expect(design).toContain("1 行の");
  expect(design).toContain("step_sessions_json.execute");
  expect(design).toContain("注入の成功自体を execute complete の根拠");
  expect(design).toContain("監査専用の lh コマンドは追加しない");
  expect(design).toContain("`usage_session_id`");
  expect(design).toContain("`active_step`");
  expect(design).toContain("`active_session_id`");
  expect(design).toContain(
    "`lh workflow run activate-step --step execute --session <session_id>`",
  );
  expect(design).toContain("`herdr pane send-keys <pane_id> Escape`");
  expect(design).toContain("「続けますか？」という yes / no");
  expect(design).toContain("人間の yes なしには再開しない");
  // Execute-side interpretation of additional work (issue/PR extension, same completion path).
  expect(design).toContain("追加作業指示");
  expect(design).toContain("Issue / PR への追加要望");
  expect(design).toContain(
    "commit（ドメイン変更がある場合）→\n必要なら PR body / comment / attachment の更新 → `lh workflow turn done`",
  );
  expect(design).toContain("issue body への追記は必須ではない");

  for (const event of [
    "workflow_run.turn_done",
    "workflow_run.escalated",
    "workflow_run.review_submitted",
    "workflow_run.github_event",
    "workflow_run.cost_exceeded",
  ]) {
    expect(design).toContain(event);
  }
  expect(design).toContain(
    "5 種類の通知はいずれも真実を代替しない timing signal",
  );
  expect(design).toContain("`resume --step execute`");
});
