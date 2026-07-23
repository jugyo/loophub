import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { workflowContractText, workflowStepContracts } from "./contracts.ts";
import { WORKFLOW_EXAMPLE_PROMPTS } from "./example-prompts.ts";

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
    "lh workflow run await-human",
    "lh workflow run increase-cost-limit",
    "lh workflow run resume",
    "lh workflow deliver",
    "lh workflow launch-step",
    "lh workflow step status",
    "lh workflow effect begin",
    "lh workflow effect complete",
    "herdr pane run",
    "herdr pane send-keys",
    "lh workflow escalate-human",
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
  expect(parent).toContain("`increment_usd`");
  expect(parent).toContain("`next_limit_usd`");
  expect(parent).toContain("`status: pending`");
  expect(parent).toContain("cursor を seed");
  expect(parent).not.toContain("pull loop");
  expect(parent).toContain(
    "lh workflow run increase-cost-limit --repo '<repo>' --run <run> --expected-limit <limit_usd>",
  );
  expect(parent).toMatch(
    /最初に `lh workflow step status <run> --repo '<repo>' --json`[\s\S]*`lh workflow run increase-cost-limit[\s\S]*増額が成功した後だけ[\s\S]*`lh workflow run resume/u,
  );
  expect(execute).toContain("lh issue view <n> --json");
  expect(execute).toContain("lh pr update <pr>");
  expect(execute).toContain("lh workflow escalate");
  expect(execute).toContain("lh workflow turn done");
  expect(verify).toContain("git diff <base sha>...<head sha>");
  expect(verify).toContain("lh pr review <pr>");
  expect(verify).toContain("--event pass|request_changes");
  expect(verify).toContain("--topic workflow");
  expect(verify).toContain("--commit <head sha>");
});

test("Execute pulls domain state itself and declares turn done", () => {
  const execute = workflowContractText("execute");

  expect(execute).toContain("lh issue view <n> --json");
  expect(execute).toContain("Read its body and comments");
  expect(execute).toContain("lh pr update <pr>");
  expect(execute).toContain(
    "lh workflow turn done --repo '<repo>' --run <run>",
  );
  expect(execute).toContain(
    "lh workflow escalate --repo '<repo>' --run <run> --reason <short summary>",
  );
  expect(execute).toContain("present the full concrete question");
  expect(execute).toContain("in the same pane");
  expect(execute).not.toContain("task.md");
  expect(execute).not.toContain("findings.md");
  expect(execute).not.toContain("execution-report");
  expect(execute).not.toContain("workflow step output");
  expect(execute).not.toContain("resolveRepo()");
  expect(execute).not.toContain("run lifecycle");
  expect(execute.match(/lh workflow turn done/gu)).toHaveLength(1);
});

test("Verify reviews a fixed merge-base-to-head diff it computes itself", () => {
  const verify = workflowContractText("verify");
  const normalizedVerify = verify.replace(/\s+/gu, " ");

  expect(verify).toContain("git diff <base sha>...<head sha>");
  expect(verify).toContain("merge-base-to-head diff");
  expect(verify).toContain("changes that exist only on the base");
  expect(verify).toContain("acceptance criteria only against");
  expect(verify).toMatch(/other ranges/iu);
  expect(verify).toMatch(/uncommitted worktree\s+changes/u);
  expect(normalizedVerify).toContain("unrelated pre-existing problems");
  expect(verify).toContain("review skill or auxiliary agent as an aid");
  expect(verify).toContain("Validate its observations yourself");
  expect(verify).toContain("lh pr review <pr>");
  expect(verify).toContain("--commit <head sha>");
  expect(verify).toContain("Submit exactly one review");
  expect(verify).toContain("with at least one line comment");
});

test("Verify three-dot review subject excludes base-only changes after divergence", () => {
  const repo = mkdtempSync(join(tmpdir(), "lh-verify-contract-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

  try {
    git("init", "--quiet");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "Test User");
    writeFileSync(join(repo, "common.txt"), "common\n");
    git("add", "common.txt");
    git("commit", "--quiet", "-m", "common");
    git("branch", "review-head");

    writeFileSync(join(repo, "base-only.txt"), "base\n");
    git("add", "base-only.txt");
    git("commit", "--quiet", "-m", "base-only");
    const baseSha = git("rev-parse", "HEAD");

    git("checkout", "--quiet", "review-head");
    writeFileSync(join(repo, "head-only.txt"), "head\n");
    git("add", "head-only.txt");
    git("commit", "--quiet", "-m", "head-only");
    const headSha = git("rev-parse", "HEAD");

    const reviewSubject = git(
      "diff",
      "--name-status",
      `${baseSha}...${headSha}`,
    ).split("\n");
    const twoDotDiff = git(
      "diff",
      "--name-status",
      `${baseSha}..${headSha}`,
    ).split("\n");

    expect(reviewSubject).toEqual(["A\thead-only.txt"]);
    expect(twoDotDiff).toContain("D\tbase-only.txt");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("Verify example prompt uses the same three-dot review subject", () => {
  expect(WORKFLOW_EXAMPLE_PROMPTS.verify_prompt).toContain(
    "git diff base...head",
  );
  expect(WORKFLOW_EXAMPLE_PROMPTS.verify_prompt).toContain(
    "merge-base-to-head diff",
  );
});

test("Verify is PR-metadata-blind while allowing source context", () => {
  const verify = workflowContractText("verify");
  const normalizedVerify = verify.replace(/\s+/gu, " ");

  expect(normalizedVerify).toContain(
    "Do not read PR body, PR comments, or the implementer's description",
  );
  expect(verify).toContain("read surrounding source as context and run tests");
  expect(verify).toContain("Do not edit source");
});

test("Verify contract omits legacy mechanics while the design rationale remains documented", () => {
  const verify = workflowContractText("verify");
  const design = readFileSync(
    join(import.meta.dirname, "..", "..", "docs", "workflow.ja.md"),
    "utf8",
  );

  expect(verify).not.toMatch(
    /task\.md|changes\.diff|report\.md|prior-verdicts|verdict artifact|step output/u,
  );
  expect(verify).not.toMatch(/freshness|stale|current HEAD|Why the asymmetry/u);
  expect(design).toContain("### 3.4 非対称性は意図的な設計判断");
  expect(design).toContain(
    "検証の独立性を、変更がどう説明・フレーミングされたかから切り離す",
  );
});

test("parent is organized around the goal and reconcile loop", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("## Goal");
  expect(parent).toContain("## Reconcile loop");
  expect(parent).toContain("## Gap table");
  expect(parent).toContain("fresh `pass` review pinned to that HEAD");
  expect(parent).toContain("The run stays `running` after reaching the goal");
  expect(parent.indexOf("## Goal")).toBeLessThan(
    parent.indexOf("## Reconcile loop"),
  );
  expect(parent.indexOf("## Reconcile loop")).toBeLessThan(
    parent.indexOf("## Gap table"),
  );
});

test("parent decides transitions by observation, never idle detection", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("lh workflow step status");
  expect(parent).toContain("not transition facts");
  expect(parent).toContain("Do not use child-session resume or idle detection");
  expect(parent.match(/idle detection/gu)).toHaveLength(1);
});

test("parent states shared lifecycle invariants once in both languages", () => {
  const parent = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  for (const [contract, freshChildRule] of [
    [parent, "Verify is **always a fresh child**"],
    [japanese, "Verify は**常に fresh child**"],
  ]) {
    expect(contract.match(/`running`/gu)).toHaveLength(1);
    expect(contract.match(/fresh child/gu)).toHaveLength(1);
    expect(contract.match(/idle detection/gu)).toHaveLength(1);
    expect(contract).toContain(freshChildRule);
  }
  expect(japanese).toMatch(
    /watch の non-zero\s+error は retry せず、人間へ判断を求める/u,
  );
});

test("parent delivers rework as a review-id pointer without summarizing findings", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("inject only the review id into Execute");
  expect(parent).toContain("orchestrator: address review #<id>");
  expect(parent).toContain("do not summarize, quote, or interpret findings");
  expect(parent).toContain(
    "lh workflow launch-step --repo '<repo>' --run <run> --step execute --review <id>",
  );
});

test("parent injects into live children via herdr and falls back to launch-step", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("lh workflow deliver");
  expect(parent).toContain("record its printed `agent` and `session` lines");
  expect(parent).toContain("orchestrator:");
  expect(parent).toContain("lh workflow run resume");
  expect(parent).not.toContain("lh workflow run enforce-cost-limit");
  expect(parent).toContain("Verify is **always a fresh child**");
  expect(parent).toContain("Do not use child-session");
});

test("parent prefers same-session Execute inject for rework, continuing, and merge conflict", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("shared Execute inject-or-launch path");
  expect(parent).toContain("same Execute session");
  expect(parent).toMatch(/All injections use `lh workflow deliver/u);
  expect(parent).toContain(
    "prefer injection into the live Execute pane and same Execute session",
  );
  expect(parent).toContain("never reuse a verifier session");
});

test("parent preserves distinct gap actions for feedback and unchanged HEAD", () => {
  const parent = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  expect(parent).toMatch(
    /`workflow_run\.github_event`[\s\S]*required changes use `request-rework`/u,
  );
  expect(parent).toContain(
    "turn done without a HEAD advance and no fresh pass",
  );
  expect(parent).toContain(
    "inject a concrete follow-up, launch Execute with `--note`, or escalate",
  );
  expect(parent).toContain("turn done without a HEAD advance and a fresh pass");
  expect(parent).toContain(
    "HEAD advances after a pass and Execute declares turn done",
  );
  expect(japanese).toContain(
    "pass 後に HEAD が進み Execute が turn done を宣言した",
  );
});

test("parent inject text is single-line and inject is not a transition fact", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("--text '<single-line instruction>'");
  expect(parent).toContain("sanitizes the instruction");
  expect(parent).toContain("Injection is delivery only");
  expect(parent).toContain("successful injection are not transition facts");
});

test("parent delegates Execute target selection to deliver in both languages", () => {
  const english = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  expect(english).toContain("latest recorded Execute agent and session");
  expect(english).toContain(
    "`agent_status: done` is still deliverable when the pane exists",
  );
  expect(japanese).toContain("最新 Execute agent と session の解決");
  expect(japanese).toContain(
    "pane が存在すれば `agent_status: done` でも delivery 可能",
  );
});

test("parent separates lifecycle transitions from live Execute delivery", () => {
  expect(workflowContractText("parent")).toContain(
    "`lh workflow deliver` for live Execute control",
  );
  expect(workflowContractText("parent", "ja")).toContain(
    "live Execute の\ncontrol は `lh workflow deliver`",
  );
});

test("parent defines the numeric rework limit once per language", () => {
  expect(
    workflowContractText("parent").match(/rework limit is 3/gu),
  ).toHaveLength(1);
  expect(workflowContractText("parent")).not.toContain("rework limit of 3");
  expect(
    workflowContractText("parent", "ja").match(/rework 上限は 3/gu),
  ).toHaveLength(1);
  expect(workflowContractText("parent", "ja")).not.toContain("rework 上限 3");
});

test("parent keeps inject-round audit details out of the contract", () => {
  const parent = workflowContractText("parent");

  expect(parent).not.toContain("Auditing inject rounds");
  expect(parent).not.toContain("rework_count");
  expect(parent).not.toContain("step_sessions_json.execute");
});

test("parent uses a runtime-managed workflow watcher and reacts to cost limit facts", () => {
  const contract = workflowContractText("parent");

  expect(contract).toContain("## Reconcile loop");
  expect(contract).toContain(
    "lh workflow watch --repo '<repo>' --run <run> --since <cursor> --json",
  );
  expect(contract).not.toContain("yielded `functions.exec` cell");
  expect(contract).not.toContain("functions.wait");
  expect(contract).toContain("exactly one ascending event");
  expect(contract).toContain("exact `next_command`");
  expect(contract).toContain(
    "start the exact returned `next_command` unchanged",
  );
  expect(contract).not.toContain("--ack");
  expect(contract).not.toContain("replay the event");
  const japanese = workflowContractText("parent", "ja");
  expect(japanese).not.toContain("--ack");
  expect(japanese).not.toContain("event を replay");
  expect(contract).not.toContain("watcher_armed");
  expect(contract).not.toContain("HERDR_PANE_ID");
  expect(contract).not.toContain("nohup lh workflow watch");
  expect(contract).toContain("workflow_run.cost_exceeded");
  expect(contract).toContain("current cumulative `limit_usd`");
  expect(contract).toContain("fixed `increment_usd`");
  expect(contract).toContain(
    "lh workflow run increase-cost-limit --repo '<repo>' --run <run> --expected-limit <limit_usd>",
  );
  expect(contract).toContain("herdr pane send-keys <pane_id> Escape");
  expect(contract).toContain("submits the literal text");
  expect(contract).toContain("usage_session_id");
  expect(contract).toContain("increment_usd");
  expect(contract).toContain("next_limit_usd");
  expect(contract).toContain("active_step");
  expect(contract).toContain("active_session_id");
  expect(contract).toContain("lh workflow deliver");
  expect(contract).toContain("Cost limit exceeded. Continue?");
  expect(contract).toContain("accept only **yes** or **no**");
  expect(contract).toContain("Handle each event id\nexactly once");
  expect(contract).toContain(
    "first run `lh workflow step status <run> --repo '<repo>' --json`",
  );
  expect(contract).toContain(
    "lh workflow run increase-cost-limit --repo '<repo>' --run <run> --expected-limit <limit_usd>",
  );
  expect(contract).toContain(
    "For Verify, launch a new child under the shared invariant",
  );
  expect(contract).toMatch(/leave the human hold in\s+place/u);
  expect(contract).toContain("do not report success or retry\nside effects");
  expect(contract).toContain(
    "lh workflow effect begin --repo '<repo>' --run <run> --event <event.id> --effect <key> --json",
  );
  expect(contract).toContain(
    "lh workflow effect complete --repo '<repo>' --run <run> --event <event.id> --effect <key>",
  );
  for (const key of [
    "cost.escape",
    "cost.pane-notification",
    "cost.human-confirmation",
  ]) {
    expect(contract).toContain(key);
  }
  expect(contract).not.toContain("escalation.issue-comment");
  expect(contract).not.toContain("escalation.inbox");
  expect(contract).toContain("print the failed command and error, run");
  expect(contract).toContain("retain or establish the");
  expect(contract).toContain("human hold");
  expect(contract).not.toContain("lh workflow run enforce-cost-limit");
  expect(contract).not.toContain("lh workflow run stop");
  expect(contract).not.toContain("sleep briefly and poll again");
});

test("parent delegates both human notifications to escalate-human in both languages", () => {
  for (const contract of [
    workflowContractText("parent"),
    workflowContractText("parent", "ja"),
  ]) {
    expect(contract).toContain(
      "lh workflow escalate-human --repo '<repo>' --run <run> --reason <text> [--issue <issue>]",
    );
    expect(contract).not.toContain("lh issue comment");
    expect(contract).not.toContain("lh inbox send");
  }
});

test("Japanese parent applies repetition to both human escalation conditions", () => {
  const contract = workflowContractText("parent", "ja");

  expect(contract).toContain(
    "HEAD advance なしの turn done の反復、child launch の反復失敗",
  );
});

test("documents recording the launch-step agent line as the injection target", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("record its printed `agent` and `session` lines");
  expect(parent).toContain("lh workflow deliver");
  expect(parent).toContain("prefer injection into the live Execute pane");
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowStepContracts();

  for (const contract of Object.values(contracts)) {
    expect(contract).toMatch(
      /messages beginning with `orchestrator:` are instructions from the workflow/u,
    );
  }
});

test("parent and execute contracts agree that the parent injects orchestrator messages", () => {
  const parent = workflowContractText("parent");
  const execute = workflowContractText("execute");

  expect(execute).toContain("launch note");
  expect(execute).toContain("messages beginning with `orchestrator:`");
  expect(execute).toContain("orchestrator: address review #<id>");
  expect(parent).toContain("orchestrator:");
  expect(parent).toContain("lh workflow deliver");
  expect(parent).not.toContain("Do not use herdr pane injection");
});

test("Execute treats additional work notes as Issue/PR requests and completes via turn done", () => {
  const execute = workflowContractText("execute");

  expect(execute).toContain("Classify follow-ups");
  expect(execute).toContain("Additional work");
  expect(execute).toContain("ordinary product or engineering work");
  expect(execute).toContain(
    "lh workflow turn done --repo '<repo>' --run <run>",
  );
  expect(execute).toContain("review response");
  expect(execute).toContain("Question-only or blocked on a human decision");
  expect(execute).toContain("Confirmation or no domain change required");
  expect(execute).toContain("Ambiguous but in scope");
  expect(execute).toContain("Running it without a commit is valid only");
  expect(execute).toMatch(/You do not need\s+to rewrite the Issue body/u);
  expect(execute.split("\n").length).toBeLessThanOrEqual(60);

  const executeJa = workflowContractText("execute", "ja");
  expect(executeJa).toContain("Rework（`orchestrator: address review #<id>`）");
  expect(executeJa).toContain("追加作業");
  expect(executeJa).toContain("質問だけ、または人間の判断待ち");
  expect(executeJa).toContain("確認のみ、またはドメイン変更不要");
  expect(executeJa).toContain("曖昧だが scope 内");
  expect(executeJa.match(/lh workflow turn done/gu)).toHaveLength(1);
  expect(executeJa.split("\n").length).toBeLessThanOrEqual(60);
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
  expect(design).toContain(
    "`pane_id` があれば `agent_status: done` でも利用できる",
  );
  expect(design).toMatch(/修正後の Verify は常に\s+fresh child/u);
  expect(design).toContain("`stopped`（#1525）は");
  expect(design).toContain("legacy status");
  expect(design).not.toContain("lh workflow run enforce-cost-limit");
  expect(design).toContain("lh workflow deliver");
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
    "`deliver` は内部で `activate-step` と同じ live-control target 更新を行う",
  );
  expect(design).toContain("`herdr pane send-keys <pane_id> Escape`");
  expect(design).toContain("「続けますか？」という yes / no");
  expect(design).toContain("人間の yes なしには増額も再開もしない");
  expect(design).toContain(
    "`lh workflow run increase-cost-limit --run <run> --expected-limit <limit_usd>`",
  );
  expect(design).toContain("Runtime-managed watcher protocol");
  expect(design).toContain('--since "$cursor"');
  expect(design).toContain("`next_command` を編集せず");
  expect(design).not.toContain("event_ack_cursor");
  expect(design).toMatch(/完了通知\s*だけを契機に同じ parent が再開/);
  expect(design).toContain("自動 replay しない");
  expect(design).not.toContain("watcher_armed");
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
