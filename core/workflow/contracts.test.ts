import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { WORKFLOW_STEPS } from "./compose.ts";
import { workflowContracts, workflowContractText } from "./contracts.ts";

test("loads every fixed contract from the canonical Markdown sources", () => {
  const contracts = workflowContracts();

  expect(contracts.parent).toContain("# Parent workflow contract");
  expect(contracts.execute).toContain("# Execute step contract");
  expect(contracts.verify).toContain("# Verify step contract");
});

test("loads Japanese translations for every fixed contract", () => {
  const contracts = workflowContracts("ja");

  expect(contracts.parent).toContain("# Parent workflow contract");
  expect(contracts.execute).toContain("# Execute ステップ contract");
  expect(contracts.verify).toContain("# Verify ステップ contract");
});

test("every fixed contract points to CLI help when workflow guidance is insufficient", () => {
  for (const language of ["en", "ja"] as const) {
    for (const contract of Object.values(workflowContracts(language))) {
      const normalized = contract.replace(/\s+/gu, " ");
      expect(contract).toContain("`lh --help`");
      expect(contract).toContain("subcommand");
      expect(normalized).toContain(
        language === "en"
          ? "Only when you need CLI usage"
          : "CLI の使い方が必要な場合に限り",
      );
      expect(normalized).toContain(
        language === "en"
          ? "Use this contract and"
          : contract.includes("Parent workflow contract")
            ? "まずこの contract と構造化された workflow 情報を使います"
            : "まずこの contract と workflow の過程で得る情報を使います",
      );
      if (language === "en") expect(normalized).toContain("first.");
    }
  }
});

test("Japanese parent delegates action procedures to delivered structured instructions", () => {
  const parent = workflowContractText("parent", "ja");
  const execute = workflowContractText("execute", "ja");
  const verify = workflowContractText("verify", "ja");

  for (const command of [
    "lh workflow run advance-to-verify",
    "lh workflow run request-rework",
    "lh workflow run resume",
    "lh workflow deliver",
    "lh workflow cost-hold",
    "lh workflow launch-step",
    "lh workflow escalate-human",
  ]) {
    expect(parent).not.toContain(command);
  }
  for (const action of [
    "complete",
    "launch_execute",
    "launch_verify",
    "advance_and_verify",
    "request_rework",
    "deliver",
    "read_github_reference",
    "cost_hold",
    "wait",
    "escalate",
    "ask_human",
  ]) {
    if (action !== "complete") expect(parent).not.toContain(`\`${action}\``);
  }
  expect(parent).toContain("workflow instruction: {...}");
  expect(parent).not.toContain("lh workflow next");
  expect(parent).toContain("構造化 instructions");
  expect(parent).not.toContain("cursor を seed");
  expect(parent).not.toContain("herdr pane send-keys <pane_id> Escape");
  expect(parent).not.toContain("pull loop");
  // The budget increase and the resume after a cost hold are the human's operation (#1859).
  expect(parent).not.toContain("lh workflow run increase-cost-limit");
  expect(parent).not.toContain("lh workflow step status");
  expect(parent).not.toContain("## Interrupts");
  expect(execute).toContain("lh issue view <n> --json");
  expect(execute).toContain("lh pr update <pr>");
  expect(execute).toContain("lh workflow escalate");
  expect(execute).toContain("lh workflow turn done");
  expect(verify).toContain("git diff <base sha>...<head sha>");
  expect(verify).toContain("lh pr review <pr>");
  expect(verify).toContain("--event pass|request_changes");
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
});

// #1896: the rubric is the issue's structured criteria, graded one by one, and the single verdict
// still decides the run transition. Both languages must carry the procedure and its aggregation.
test("Verify grades the structured acceptance criteria as a rubric in both languages", () => {
  const verify = workflowContractText("verify");
  const japanese = workflowContractText("verify", "ja");

  expect(verify).toContain("--ac-results <json|file>");
  expect(verify).toContain("structured `acceptance_criteria`");
  expect(verify).toContain(
    "Ignore the body's `## Acceptance criteria` markdown",
  );
  expect(verify).toContain(
    "Grade every enabled criterion independently against the fixed diff",
  );
  expect(verify).toContain("necessary but not sufficient");
  expect(verify).toContain(
    "A single\nfailing criterion makes it `request_changes`",
  );
  expect(verify).toContain("holistic fallback is normal, not an error");
  expect(verify).toContain("recorded with a visible warning");

  expect(japanese).toContain("--ac-results <json|file>");
  expect(japanese).toContain("構造化 `acceptance_criteria`");
  expect(japanese).toContain(
    "body の `## Acceptance criteria` markdown は存在しても参照しません",
  );
  expect(japanese).toContain("1 項目でも fail なら `request_changes`");
  expect(japanese).toContain("必要条件ですが単独では十分条件ではなく");
  expect(japanese).toContain("エラーではありません");
  expect(japanese).toContain("可視 warning とともに記録されます");
});

// #1896: the pre-rubric contract required at least one line comment on `request_changes`. A failing
// grade's `note` now carries the actionable detail, so the requirement is gone in both languages.
test("Verify no longer requires a line comment on request_changes", () => {
  const verify = workflowContractText("verify");
  const japanese = workflowContractText("verify", "ja");

  expect(verify).toContain("Line comments are optional");
  expect(verify).not.toContain("at least one line comment");
  expect(japanese).toContain("line comment は任意です");
  expect(japanese).not.toContain("line comment が 1 件以上必要");
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

test("parent is organized around the goal and instruction loop", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("## Goal");
  expect(parent).toContain("## Instruction loop");
  expect(parent).toContain("## Structured instructions");
  expect(parent).toContain("fresh `pass` review pinned to that HEAD");
  expect(parent).toContain("The run stays `running` after reaching the goal");
  expect(parent.indexOf("## Goal")).toBeLessThan(
    parent.indexOf("## Instruction loop"),
  );
  expect(parent.indexOf("## Instruction loop")).toBeLessThan(
    parent.indexOf("## Structured instructions"),
  );
});

test("parent names PR close as the terminal condition in both languages", () => {
  const parent = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  expect(parent).toContain(
    "Closing the linked PR is the run's terminal condition",
  );
  expect(japanese).toContain("linked PR の close が run の terminal condition");
});

test("parent decides transitions by observation, never idle detection", () => {
  const parent = workflowContractText("parent");

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
    // Actions / Interrupts point back at the invariant above instead of restating it.
    expect(contract).not.toMatch(/fresh (launch|Verify)/u);
    expect(contract).not.toContain("resolveRepo()");
  }
  expect(japanese).toContain(
    "不正な instruction や action の non-zero error は retry せず",
  );
});

test("parent delivers rework as a review-id pointer without summarizing findings", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("orchestrator: address review #<id>");
  expect(parent).toContain("do not summarize or interpret the findings");
  expect(parent).not.toContain("--step execute --review <id>");
});

test("parent delivers to live children and leaves delivery errors visible", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("ordered list of executable `lh` argv");
  expect(parent).toContain("Keep a non-zero action error");
  expect(parent).toContain("do not retry or add recovery");
  expect(parent).toContain("orchestrator:");
  expect(parent).not.toContain("lh workflow run enforce-cost-limit");
  expect(parent).toContain("Verify is **always a fresh child**");
  expect(parent).toContain("Do not use child-session");
});

test("parent uses one same-session Execute delivery path", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain(
    "For delivery text, write one concrete single-line instruction",
  );
  expect(parent).toContain("`input` entry names the one value");
  expect(parent).toContain("never reuse a verifier session");
});

test("parent delegates transition decisions to worker-delivered results", () => {
  const parent = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  expect(parent).not.toContain("lh workflow next");
  expect(parent).toContain(
    "lh workflow instruction <run> --repo '<repo>' --note <text|-> --json",
  );
  for (const contract of [parent, japanese]) {
    expect(contract).toContain("`commands`");
    expect(contract).toContain("`decision`");
    expect(contract).toContain("`after`");
    expect(contract).not.toContain("--event <event.id>");
  }
  expect(parent).toMatch(
    /The delivered result is the only source for selecting an action/u,
  );
  expect(parent).toContain(
    "Execute the returned structured `instructions` exactly",
  );
  expect(parent).not.toContain("instead of the returned action");
  expect(parent).not.toContain("- `launch_verify`:");
  expect(parent).not.toContain("- `advance_and_verify`:");
  expect(parent).not.toContain("When `transition` is `advance_to_verify`");
  expect(parent).not.toContain("When\n  `transition` is `null`");
  expect(parent).not.toContain("- `wait`:");
  expect(parent).not.toContain("When `transition` is `resume_execute`");
  expect(parent).not.toContain("## Gap table");
  expect(parent).not.toContain("Translate events into gaps");
  expect(japanese).not.toContain("## gap 表");
  expect(japanese).not.toContain("event を gap へ翻訳する");
});

test("parent inject text is single-line and inject is not a transition fact", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("single-line instruction");
  expect(parent).toContain("`input` entry names the one value");
  expect(parent).toContain("successful injection are not transition facts");
});

test("parent delegates Execute target selection to deliver in both languages", () => {
  const english = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  expect(english).toContain("Run it in order");
  expect(english).toContain("do not invent other transitions");
  expect(japanese).toContain("記載順に実行する");
  expect(japanese).toContain("ほかの遷移を独自に作らない");
});

test("parent separates lifecycle actions from live Execute delivery", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("structured `instructions`");
  expect(parent).not.toContain("lh workflow run advance-to-verify");
  expect(parent).not.toContain("lh workflow run request-rework");
  expect(parent).not.toContain("lh workflow deliver");
});

test("parent delegates the rework limit decision to the delivered instruction", () => {
  expect(workflowContractText("parent")).not.toContain("rework limit");
  expect(workflowContractText("parent", "ja")).not.toContain("rework 上限");
});

test("parent keeps inject-round audit details out of the contract", () => {
  const parent = workflowContractText("parent");

  expect(parent).not.toContain("Auditing inject rounds");
  expect(parent).not.toContain("rework_count");
  expect(parent).not.toContain("step_sessions_json.execute");
});

test("parent waits for worker instructions and reacts to cost limit facts", () => {
  const contract = workflowContractText("parent");

  expect(contract).toContain("## Instruction loop");
  expect(contract).toContain("workflow instruction: {...}");
  expect(contract).toContain("Do not fetch an instruction yourself");
  expect(contract).not.toContain("functions.exec");
  expect(contract).not.toContain("functions.wait");
  expect(contract).not.toContain("background cell");
  expect(contract).not.toContain("watcher writes JSONL records");
  expect(contract).not.toContain("logs/workflow-watch");
  expect(contract).not.toContain("not armed");
  expect(contract).toContain(
    "worker owns event delivery, its order, duplicate prevention, and where to resume",
  );
  expect(contract).toMatch(
    /Do not seed, persist, edit, or\s+acknowledge a cursor/u,
  );
  expect(contract).not.toContain("lh workflow watch");
  expect(contract).not.toContain("next_command");
  expect(contract).not.toContain("--since");
  expect(contract).not.toContain("--ack");
  expect(contract).not.toContain("replay the event");
  const japanese = workflowContractText("parent", "ja");
  expect(japanese).not.toContain("lh workflow watch");
  expect(japanese).not.toContain("next_command");
  expect(japanese).not.toContain("--since");
  expect(japanese).not.toContain("--ack");
  expect(japanese).not.toContain("event を replay");
  expect(japanese).toContain("worker");
  expect(contract).not.toContain("watcher_armed");
  expect(contract).not.toContain("HERDR_PANE_ID");
  // #1859: the cost procedure collapsed into one action. The parent runs the receipt-guarded
  // command and returns to the loop; the budget decision, its limit, and the resume are the
  // human's, so no yes/no question, `step status`, `increase-cost-limit`, or resume remains here.
  expect(contract).not.toContain("current cumulative `limit_usd`");
  expect(japanese).not.toContain("現在累計 `limit_usd`");
  expect(contract).not.toContain("lh workflow run increase-cost-limit");
  expect(contract).not.toContain("lh workflow step status");
  expect(contract).not.toContain("Cost limit exceeded. Continue?");
  expect(contract).not.toContain("already_completed");
  expect(contract).not.toContain("limit_usd");
  expect(japanese).not.toContain("limit_usd");
  expect(contract).toContain(
    "Cost hold and escalation commands own their receipts and human",
  );
  expect(contract).toContain("never raise the cost limit");
  expect(japanese).toContain(
    "cost hold と escalation の\ncommand が receipt と人間への通知を管理する",
  );
  expect(contract).not.toContain("herdr pane send-keys <pane_id> Escape");
  expect(contract).not.toContain("submits the literal text");
  expect(contract).not.toContain("usage_session_id");
  expect(contract).not.toContain("increment_usd");
  expect(contract).not.toContain("next_limit_usd");
  expect(contract).not.toContain("lh workflow deliver");
  expect(contract).not.toContain("lh workflow cost-hold");
  expect(contract).not.toContain("cost.escape");
  expect(contract).not.toContain("cost.pane-notification");
  expect(contract).not.toContain("cost.human-confirmation");
  expect(contract).toContain("any completed prior command visible");
  expect(contract).toContain("do not retry or add recovery");
  expect(contract).not.toContain("lh workflow run enforce-cost-limit");
  expect(contract).not.toContain("lh workflow run stop");
  expect(contract).not.toContain("sleep briefly and poll again");
});

test("English and Japanese parent contracts prohibit the old watcher protocol", () => {
  for (const language of ["en", "ja"] as const) {
    const contract = workflowContractText("parent", language);
    expect(contract).not.toContain("functions.exec");
    expect(contract).not.toContain("functions.wait");
    expect(contract).not.toContain("exec_command");
    expect(contract).not.toContain("write_stdin");
    expect(contract).not.toContain("session_id");
    expect(contract).toContain("workflow instruction: {...}");
    expect(contract).not.toContain("lh workflow next");
    expect(contract).toContain("Execute / Verify");
  }
});

test("parent delegates the human notification to escalate-human in both languages", () => {
  for (const contract of [
    workflowContractText("parent"),
    workflowContractText("parent", "ja"),
  ]) {
    expect(contract).toMatch(/escalation[\s\S]*receipt[\s\S]*(human|人間)/u);
    expect(contract).not.toContain("lh issue comment");
    expect(contract).not.toContain("lh inbox send");
    expect(contract).not.toContain("Inbox");
  }
});

test("parent escalation notifies the human without holding the run", () => {
  const parent = workflowContractText("parent");
  const japanese = workflowContractText("parent", "ja");

  expect(parent).toContain(
    "Cost hold and escalation commands own their receipts and human",
  );
  expect(parent).toContain("do not retry or add recovery");
  expect(japanese).toContain("receipt と人間への通知を管理する");
  expect(japanese).toContain("retry や recovery を追加せず");
});

test("documents structured command ordering and delivery input", () => {
  const parent = workflowContractText("parent");

  expect(parent).toContain("ordered list of executable `lh` argv");
  expect(parent).toContain("Run it in order");
  expect(parent).toContain(
    "For delivery text, write one concrete single-line instruction",
  );
});

test("identifies orchestrator-prefixed messages in every child contract", () => {
  const contracts = workflowContracts();

  for (const step of WORKFLOW_STEPS) {
    expect(contracts[step]).toMatch(
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
  expect(parent).toContain(
    "the returned command already contains the exact `orchestrator: address review #<id>`",
  );
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
  expect(execute).toContain(
    "Diff feedback (`orchestrator: address diff feedback thread #<t> comment #<c>`)",
  );
  expect(execute).toContain("lh pr feedback pending <pr> --run <run> --json");
  expect(execute).toContain(
    "PR comment (`orchestrator: address PR comment #<c>`)",
  );
  expect(execute.split("\n").length).toBeLessThanOrEqual(74);

  const executeJa = workflowContractText("execute", "ja");
  expect(executeJa).toContain("Rework（`orchestrator: address review #<id>`）");
  expect(executeJa).toContain(
    "Diff feedback（`orchestrator: address diff feedback thread #<t> comment #<c>`）",
  );
  expect(executeJa).toContain(
    "PR comment（`orchestrator: address PR comment #<c>`）",
  );
  expect(executeJa).toContain("追加作業");
  expect(executeJa).toContain("質問だけ、または人間の判断待ち");
  expect(executeJa).toContain("確認のみ、またはドメイン変更不要");
  expect(executeJa).toContain("曖昧だが scope 内");
  expect(executeJa.match(/lh workflow turn done/gu)).toHaveLength(1);
  expect(executeJa.split("\n").length).toBeLessThanOrEqual(75);
});

test("Execute acknowledges implementation follow-ups before editing in both languages", () => {
  const execute = workflowContractText("execute");
  const executeJa = workflowContractText("execute", "ja");
  const normalizedExecute = execute.replace(/\s+/gu, " ");
  const normalizedExecuteJa = executeJa.replace(/\s+/gu, " ");

  for (const contract of [execute, executeJa]) {
    expect(contract).toContain("lh pr comment <pr> --body <text>");
    expect(contract).toContain(
      "lh pr feedback reply <t> --pr <pr> --body <text>",
    );
    expect(contract).toContain("review #<id>");
    expect(contract).toContain("review comment #<id>");
    expect(contract).toContain("comment #<c>");
  }

  expect(execute).toContain("before editing");
  expect(execute).toContain("acknowledges the findings");
  expect(execute).toContain("states that you will address");
  expect(normalizedExecute).toContain(
    "before editing post a brief top-level `lh pr comment <pr> --body <text>` acknowledgement that identifies `review #<id>`",
  );
  expect(normalizedExecute).toContain(
    "first post a brief reply in its thread before editing",
  );
  expect(normalizedExecute).toContain(
    "before editing post a brief top-level `lh pr comment <pr> --body <text>` acknowledgement that identifies `comment #<c>`",
  );
  expect(execute.match(/\bbrief\b/gu)).toHaveLength(3);
  expect(execute).toContain(
    "Acknowledgement before editing is not required when no source change is needed",
  );
  expect(executeJa).toContain("編集前に");
  expect(executeJa).toContain("finding を\n  認識したことと対応する意思");
  expect(normalizedExecuteJa).toContain(
    "編集前に `lh pr comment <pr> --body <text>` で短い top-level の着手返信",
  );
  expect(normalizedExecuteJa).toContain("編集前にまずその thread へ短く返信");
  expect(executeJa.match(/短い|短く/gu)).toHaveLength(3);
  expect(executeJa).toContain(
    "source の修正が不要なら編集前の着手返信は\n  必須ではありません",
  );
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
  // #2150: a run owns at most one live Execute child, so a failed injection goes to a human
  // instead of relaunching a second executor into the same worktree.
  expect(design).not.toContain("`--note` 付きで Execute を launch");
  expect(design).toContain("deliver が失敗すれば二重起動を避けて人間へ渡す");
  expect(design).toContain(
    "PR body・comment・attachment だけの更新は HEAD を変えない",
  );
  expect(design).toContain(
    "DB 上の最新 Execute session と保存済み実行 target を再利用する",
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
  expect(design).toContain("agent-control port の key input");
  // #1859: the parent runs the `cost_hold` action and returns to the loop; the continuation
  // decision, the increase, and the resume are the human's.
  expect(design).not.toContain("「続けますか？」という yes / no");
  expect(design).toContain("人間の判断なしには増額も再開もしない");
  expect(design).toContain("`cost_hold` action");
  expect(design).toContain("`read_github_reference`");
  expect(design).toContain(
    "`lh workflow run increase-cost-limit --run <run> --expected-limit <limit_usd>`",
  );
  expect(design).toContain("Worker instruction delivery");
  expect(design).toContain("workflow instruction: <JSON>");
  expect(design).toContain(
    "注入成功または同一判断の抑止後だけ cursor を進める",
  );
  expect(design).not.toContain("event_ack_cursor");
  expect(design).not.toContain("next_command");
  expect(design).toContain("run に登録済みの唯一の parent pane");
  expect(design).toContain(
    "`workflow.instruction:<fingerprint>` effect receipt",
  );
  expect(design).not.toContain("watcher_armed");
  // Execute-side interpretation of additional work (issue/PR extension, same completion path).
  expect(design).toContain("追加作業指示");
  expect(design).toContain("Issue / PR への追加要望");
  expect(design).toContain(
    "commit（ドメイン変更がある場合）→\n必要なら PR body / comment / attachment の更新 → `lh workflow turn done`",
  );
  expect(design).toContain("issue body への追記は必須ではない");
  expect(design).toContain("human follow-up が source の修正を要求する場合");
  expect(design).toContain("編集前に短い着手返信");
  expect(design).toContain("対象 `comment #<id>`");
  expect(design).toContain("`review #<id>`");
  expect(design).toContain("対応するすべての `review comment #<id>`");
  expect(design).toContain(
    "source の修正を伴わない follow-up では、この着手返信を",
  );

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
