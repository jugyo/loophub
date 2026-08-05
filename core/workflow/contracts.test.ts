import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  WORKFLOW_CONTRACT_LANGUAGES,
  WORKFLOW_CONTRACTS,
  workflowContracts,
} from "./contracts.ts";

function expectParagraphWithMarkers(text: string, markers: string[]): void {
  const paragraphs = text
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/\s+/gu, " "));
  expect(
    paragraphs.some((paragraph) =>
      markers.every((marker) => paragraph.includes(marker)),
    ),
  ).toBe(true);
}

function expectListItemWithMarkers(text: string, markers: string[]): void {
  const listItems = text
    .split(/\n(?=- \*\*)/gu)
    .map((item) => item.replace(/\s+/gu, " "));
  expect(
    listItems.some((item) => markers.every((marker) => item.includes(marker))),
  ).toBe(true);
}

// Contract tests intentionally cover loading, executable command structure, and safety
// boundaries. Explanatory prose, headings, line wrapping, and translations are authoring details
// that should remain free to improve without requiring test updates.
test("loads every fixed contract from its canonical Markdown source", () => {
  for (const language of WORKFLOW_CONTRACT_LANGUAGES) {
    const contracts = workflowContracts(language);
    expect(Object.keys(contracts)).toEqual(WORKFLOW_CONTRACTS);

    for (const contract of WORKFLOW_CONTRACTS) {
      const suffix = language === "en" ? "" : `.${language}`;
      expect(contracts[contract]).toBe(
        readFileSync(
          join(import.meta.dirname, "contracts", `${contract}${suffix}.md`),
          "utf8",
        ),
      );
    }
  }
});

test("contracts preserve the workflow command protocol in both languages", () => {
  for (const language of WORKFLOW_CONTRACT_LANGUAGES) {
    const { parent, execute, verify } = workflowContracts(language);
    const normalizedExecute = execute.replace(/\s+/gu, " ");

    for (const contract of [parent, execute, verify]) {
      expect(contract).toContain("`lh --help`");
      expect(contract).not.toMatch(/\/lh-[a-z]/u);
    }

    expect(parent).toContain("orchestrator: address review <id>");
    // The parent runs the lifecycle commands itself now, so each one it may reach for is spelled
    // out in the contract rather than arriving inside a delivered instruction.
    for (const command of [
      "lh events subscribe --repo '<repo>' --target herdr-pane",
      "lh events unsubscribe --subscription <id>",
      "lh workflow state <run> --repo '<repo>' --state-version 1 --json",
      "lh workflow launch-step --repo '<repo>' --run <run> --step execute",
      "lh workflow launch-step --repo '<repo>' --run <run> --step verify",
      "lh workflow run advance-to-verify --repo '<repo>' --run <run>",
      "lh workflow run request-rework --repo '<repo>' --run <run> --review <id>",
      "lh workflow run resume --repo '<repo>' --run <run> --step execute",
      "lh workflow deliver --repo '<repo>' --run <run>",
      "lh workflow cost-hold --repo '<repo>' --run <run>",
      "lh workflow escalate-human --repo '<repo>' --run <run>",
    ]) {
      expect(parent).toContain(command);
    }

    for (const command of [
      "lh workflow next",
      "lh workflow watch",
      "lh workflow parent-ready",
      "lh workflow instruction",
      "lh workflow run enforce-cost-limit",
      "lh workflow run increase-cost-limit",
      "lh workflow step status",
      "lh subscribe --repo",
    ]) {
      expect(parent).not.toContain(command);
    }
    for (const retiredAction of [
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
      expect(parent).not.toContain(`\`${retiredAction}\``);
    }
    for (const legacyMarker of [
      "functions.exec",
      "functions.wait",
      "exec_command",
      "write_stdin",
      "--since",
      "--ack",
      "session_id",
      "next_command",
      "watcher_armed",
      "event_ack_cursor",
      "workflow instruction:",
      // The run's lifecycle `status` left the state, so the contract must not name it as a field.
      "`status`",
    ]) {
      expect(parent).not.toContain(legacyMarker);
    }

    for (const command of [
      "lh issue view <n> --json",
      "lh pr view <pr> --json",
      "lh pr update <pr> --repo '<repo>' --title <title> --body ...",
      "lh pr review view <pr> --review <id> --json",
      "lh pr review-response add <pr> --review <id> [--review-comment <id>] --body <text>",
      "lh pr feedback pending <pr> --run <run> --json",
      "lh pr feedback reply <t> --pr <pr> --body <text>",
      "lh pr comment <pr> --body <text>",
      "lh workflow escalate --repo '<repo>' --run <run> --reason <short summary>",
      "lh workflow turn done --repo '<repo>' --run <run>",
    ]) {
      expect(normalizedExecute).toContain(command);
    }
    expect(execute.match(/lh workflow turn done/gu)).toHaveLength(1);

    expect(verify).toContain("git diff <base sha>...<head sha>");
    expect(verify).toContain("lh issue view <n> --repo '<repo>' --json");
    expect(verify).toMatch(
      /lh pr review <pr>[\s\S]*--repo '<repo>'[\s\S]*--commit <head sha>[\s\S]*--event pass\|request_changes/u,
    );
    expect(verify).toContain("--ac-results <json|file>");
    expect(verify).not.toContain("lh pr view");
  }
});

// The parent's loop is the contract's load-bearing part: it is what decides whether the agent acts
// on a read of current state or on whatever text reached its pane, so both the four stages and
// their order are asserted rather than left to prose review.
test("the parent contract runs a subscribe / observe / reconcile / unsubscribe loop", () => {
  const stages = {
    en: ["**Subscribe**", "**Observe**", "**Reconcile**", "**unsubscribe**"],
    ja: ["**subscribe**", "**observe**", "**reconcile**", "**unsubscribe**"],
  };
  const stateOverEvents = {
    en: "**Decide what to do from state. Read events only to find out how something came about.**",
    ja: "**行動は state で決める。events は経緯を調べるときに読む。**",
  };

  for (const language of WORKFLOW_CONTRACT_LANGUAGES) {
    const { parent } = workflowContracts(language);
    expect(parent).toContain(stateOverEvents[language]);

    let previous = -1;
    for (const stage of stages[language]) {
      const at = parent.indexOf(stage);
      expect(at).toBeGreaterThan(previous);
      previous = at;
    }
  }
});

// The delivery-independent invariants are the run's definition of done, not part of how the parent
// is woken, so replacing the loop must leave every one of them standing.
test("the parent contract keeps the goal invariants that outlive the wake-up path", () => {
  const invariants = {
    en: [
      "Pane output, child self-reports, event verdict payloads, PR body markers",
      "**always a fresh child**",
      "The state's `done` is the canonical pre-merge Done signal",
      "Do not use child-session resume or idle detection",
      "Never merge. Closing the linked PR is the run's terminal condition",
    ],
    ja: [
      "pane output、child の自己申告、event payload の verdict、",
      "**常に fresh child**",
      "state の `done` が pre-merge の canonical な Done signal である",
      "child-session resume や idle detection は使わない",
      "merge はしない。linked PR の close が run の terminal condition である",
    ],
  };

  for (const language of WORKFLOW_CONTRACT_LANGUAGES) {
    const { parent } = workflowContracts(language);
    for (const invariant of invariants[language]) {
      expect(parent).toContain(invariant);
    }
  }
});

test("contracts exclude retired artifact and recovery protocols", () => {
  for (const language of WORKFLOW_CONTRACT_LANGUAGES) {
    const contracts = workflowContracts(language);
    const childContracts = [contracts.execute, contracts.verify];

    for (const contract of childContracts) {
      expect(contract).toContain("orchestrator:");
    }
    for (const artifact of [
      "task.md",
      "changes.diff",
      "report.md",
      "prior-verdicts",
      "execution-report",
    ]) {
      for (const contract of Object.values(contracts)) {
        expect(contract).not.toContain(artifact);
      }
    }
  }
});

test("Verify keeps the fixed-diff boundary independent from PR metadata", () => {
  const contracts = [
    {
      text: workflowContracts("en").verify,
      metadataMarkers: [
        "git diff <base sha>...<head sha>",
        "PR body",
        "PR comments",
        "implementer's description",
        "Do not read",
      ],
    },
    {
      text: workflowContracts("ja").verify,
      metadataMarkers: [
        "git diff <base sha>...<head sha>",
        "PR body",
        "PR comments",
        "implementer の description",
        "読みません",
      ],
    },
  ];

  for (const { text, metadataMarkers } of contracts) {
    expectParagraphWithMarkers(text, metadataMarkers);
    expect(text).not.toContain("lh pr view");
  }
});

test("Verify keeps structured rubric grading and verdict aggregation together", () => {
  const contracts = [
    {
      text: workflowContracts("en").verify,
      bodyBoundary: [
        "structured `acceptance_criteria`",
        "body's `## Acceptance criteria` markdown",
        "Ignore",
      ],
      gradeShape: [
        "--ac-results",
        '"criterion_id": "42-1"',
        '"verdict"',
        '"note"',
        "exactly once",
      ],
      aggregation: [
        "all criteria passing is necessary but not sufficient",
        "failing criterion",
        "request_changes",
      ],
    },
    {
      text: workflowContracts("ja").verify,
      bodyBoundary: [
        "構造化 `acceptance_criteria`",
        "body の `## Acceptance criteria` markdown",
        "参照しません",
      ],
      gradeShape: [
        "--ac-results",
        '"criterion_id": "42-1"',
        '"verdict"',
        '"note"',
        "ちょうど 1 回ずつ",
      ],
      aggregation: [
        "必要条件",
        "十分条件ではなく",
        "1 項目でも fail",
        "request_changes",
      ],
    },
  ];

  for (const { text, bodyBoundary, gradeShape, aggregation } of contracts) {
    expectParagraphWithMarkers(text, bodyBoundary);
    expectParagraphWithMarkers(text, gradeShape);
    expectParagraphWithMarkers(text, aggregation);
  }
});

test("Verify carries one child result format shared by both languages", () => {
  const section = (text: string, heading: string): string => {
    const start = text.indexOf(heading);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = text.slice(start + heading.length);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  };

  const contracts = [
    {
      text: workflowContracts("en").verify,
      heading: "## Fan out to child agents",
      optOut: ["does not fan out", "ignores this section"],
      aid: ["review skill or auxiliary agent", "Validate its observations"],
    },
    {
      text: workflowContracts("ja").verify,
      heading: "## child agent への fan out",
      optOut: ["fan out しない", "この節を無視"],
      aid: ["skill や auxiliary agent", "自分で検証します"],
    },
  ];

  const blocks = contracts.map(({ text, heading, optOut, aid }) => {
    const fanOut = section(text, heading);
    // One tagged block per contract keeps the cross-language comparison below anchored to this one.
    expect(text.match(/```json/gu)).toHaveLength(1);
    expectParagraphWithMarkers(fanOut, ["fan out", "child", "JSON"]);
    expectParagraphWithMarkers(fanOut, optOut);
    // The aid rule applies to every Verify, so it stays outside the section a run may ignore.
    expect(fanOut).not.toContain("auxiliary agent");
    expectParagraphWithMarkers(text, aid);

    const match = fanOut.match(/```json\n([\s\S]*?)```/u);
    expect(match).not.toBeNull();
    return match?.[1] ?? "";
  });

  // Structural labels stay identical across languages; only the prose around them is localized.
  expect(blocks[0]).toBe(blocks[1]);
  for (const marker of [
    '"status": "complete|failed"',
    '"severity": "blocking|non_blocking"',
    '"claim"',
    '"evidence"',
    '"checks"',
  ]) {
    expect(blocks[0]).toContain(marker);
  }
});

test("parent keeps non-zero action errors visible without retry or recovery", () => {
  expectParagraphWithMarkers(workflowContracts("en").parent, [
    "non-zero action error",
    "visible",
    "do not retry",
    "recovery",
  ]);
  expectParagraphWithMarkers(workflowContracts("ja").parent, [
    "非 0 error",
    "可視",
    "retry",
    "recovery",
  ]);
});

test("parent keeps lifecycle facts, child freshness, and reconcile ownership explicit", () => {
  const contracts = [
    {
      text: workflowContracts("en").parent,
      transitionFacts: ["successful injection", "not transition facts"],
      verifierFreshness: [
        "Verify is **always a fresh child**",
        "never reuse a verifier session",
      ],
      childState: ["child-session resume", "idle detection", "Do not use"],
      reconcileOwnership: [
        "Read the entries in order",
        "run only the first one that matches",
        "wait for the next ping",
      ],
    },
    {
      text: workflowContracts("ja").parent,
      transitionFacts: ["注入成功", "transition fact", "ではない"],
      verifierFreshness: [
        "Verify は**常に fresh child**",
        "verifier session を再利用しない",
      ],
      childState: ["child-session resume", "idle detection", "使わない"],
      reconcileOwnership: [
        "上から順に見て",
        "最初に当てはまる 1 つだけを実行し",
        "次の ping を待つ",
      ],
    },
  ];

  for (const {
    text,
    transitionFacts,
    verifierFreshness,
    childState,
    reconcileOwnership,
  } of contracts) {
    expectParagraphWithMarkers(text, transitionFacts);
    expectParagraphWithMarkers(text, verifierFreshness);
    expectParagraphWithMarkers(text, childState);
    expectParagraphWithMarkers(text, reconcileOwnership);
  }
});

test("parent keeps linked PR close as the terminal condition", () => {
  expectParagraphWithMarkers(workflowContracts("en").parent, [
    "linked PR",
    "Closing",
    "terminal condition",
  ]);
  expectParagraphWithMarkers(workflowContracts("ja").parent, [
    "linked PR",
    "close",
    "terminal condition",
  ]);
});

test("Execute keeps follow-up classification and reply destinations together", () => {
  const contracts = [
    {
      text: workflowContracts("en").execute,
      categories: [
        ["Rework", "orchestrator: address review <id>"],
        [
          "Diff feedback",
          "orchestrator: address diff feedback thread <t> comment <c>",
        ],
        ["PR comment", "orchestrator: address PR comment <c>"],
        ["Additional work", "ordinary product or engineering work"],
        ["Question-only", "lh workflow escalate"],
        ["Confirmation or no domain change required", "metadata-only"],
        ["Ambiguous but in scope", "smallest implementation"],
      ],
      reworkReply: [
        "orchestrator: address review <id>",
        "lh pr review-response add",
        "do not use a top-level `lh pr comment`",
      ],
      diffReply: [
        "orchestrator: address diff feedback",
        "lh pr feedback reply",
        "requiring source changes",
        "before editing",
      ],
      prReply: [
        "orchestrator: address PR comment",
        "lh pr comment <pr> --body <text>",
        "requires source changes",
        "before editing",
      ],
      metadataOnly: [
        "no domain change required",
        "Acknowledgement before editing is not required",
        "no source change",
      ],
    },
    {
      text: workflowContracts("ja").execute,
      categories: [
        ["Rework", "orchestrator: address review <id>"],
        [
          "Diff feedback",
          "orchestrator: address diff feedback thread <t> comment <c>",
        ],
        ["PR comment", "orchestrator: address PR comment <c>"],
        ["追加作業", "product / engineering 要求"],
        ["質問だけ、または人間の判断待ち", "lh workflow escalate"],
        ["確認のみ、またはドメイン変更不要", "metadata-only"],
        ["曖昧だが scope 内", "最小の実装"],
      ],
      reworkReply: [
        "orchestrator: address review <id>",
        "lh pr review-response add",
        "top-level の `lh pr comment` は使いません",
      ],
      diffReply: [
        "orchestrator: address diff feedback",
        "lh pr feedback reply",
        "source の修正が必要",
        "編集前",
      ],
      prReply: [
        "orchestrator: address PR comment",
        "lh pr comment <pr> --body <text>",
        "source の修正が必要",
        "編集前",
      ],
      metadataOnly: [
        "ドメイン変更不要",
        "source の修正が不要",
        "編集前の着手返信",
        "必須ではありません",
      ],
    },
  ];

  for (const {
    text,
    categories,
    reworkReply,
    diffReply,
    prReply,
    metadataOnly,
  } of contracts) {
    for (const markers of categories) {
      expectListItemWithMarkers(text, markers);
    }
    expectListItemWithMarkers(text, reworkReply);
    expectListItemWithMarkers(text, diffReply);
    expectListItemWithMarkers(text, prReply);
    expectListItemWithMarkers(text, metadataOnly);
  }
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
