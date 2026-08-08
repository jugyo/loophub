import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { commandHelp } from "../../cli/help.ts";
import {
  WORKFLOW_CONTRACT_LANGUAGES,
  WORKFLOW_CONTRACTS,
  workflowContracts,
} from "./contracts.ts";

// Contract tests intentionally cover loading, the executable commands the contracts quote, and the
// structural labels their JSON blocks share. Explanatory prose, headings, line wrapping, and
// translations are authoring details that should remain free to improve without test updates.
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

test("Verify carries one child result format shared by both languages", () => {
  const blocks = WORKFLOW_CONTRACT_LANGUAGES.map((language) => {
    const matches = [
      ...workflowContracts(language).verify.matchAll(
        /```json\n([\s\S]*?)```/gu,
      ),
    ];
    // One tagged block per contract keeps the cross-language comparison anchored to it.
    expect(matches).toHaveLength(1);
    return matches[0]?.[1] ?? "";
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

/**
 * Command lines quoted by a contract, normalized to one line each. Quotes live either in a fenced
 * block (where a trailing backslash continues the line) or in an inline code span (which may wrap
 * across source lines).
 */
function commandQuotes(markdown: string): string[] {
  const fenced = [...markdown.matchAll(/```[a-z]*\n([\s\S]*?)```/gu)].flatMap(
    ([, block]) => block.replace(/\\\n/gu, " ").split("\n"),
  );
  const inline = [
    ...markdown.replace(/```[\s\S]*?```/gu, "").matchAll(/`([^`]+)`/gu),
  ].map(([, span]) => span);
  return [...fenced, ...inline]
    .map((quote) => quote.replace(/\s+/gu, " ").trim())
    .filter((quote) => quote.startsWith("lh "));
}

/** The subcommand path of a quote: the bare words before the first placeholder or flag. */
function commandPath(quote: string): string[] {
  const path: string[] = [];
  for (const word of quote.split(" ").slice(1)) {
    if (!/^[a-z][a-z0-9-]*$/u.test(word)) break;
    path.push(word);
  }
  return path;
}

function commandFlags(quote: string): string[] {
  return [...quote.matchAll(/(?<![\w-])--[a-z][a-z0-9-]*/gu)].map(
    ([flag]) => flag,
  );
}

function commandHelpForQuotedPath(path: string[]) {
  return (
    commandHelp.find(
      (entry) =>
        entry.path.length === path.length &&
        entry.path.every((part, index) => path[index] === part),
    ) ??
    commandHelp.find((entry) => {
      if (entry.path.length >= path.length || !entry.details) return false;
      if (!entry.path.every((part, index) => path[index] === part))
        return false;
      return entry.details.includes(`lh ${path.join(" ")}`);
    })
  );
}

/*
 * mutation 確認記録:
 * `workflow parent-ready` の registry path を一時的に別名へ変更し、
 * `npm exec vitest run core/workflow/contracts.test.ts` を実行した。
 * 結果は対象テスト 1 件失敗、`expected undefined to be defined` だった。
 * 確認後に registry path を元へ戻した。
 */
test("does not treat extra positional arguments as a documented command", () => {
  expect(
    commandHelpForQuotedPath(["workflow", "turn", "done", "not-a-command"]),
  ).toBeUndefined();
});

test("contracts quote only commands and flags the CLI documents", () => {
  for (const language of WORKFLOW_CONTRACT_LANGUAGES) {
    for (const [contract, text] of Object.entries(
      workflowContracts(language),
    )) {
      let quoted = 0;
      for (const quote of commandQuotes(text)) {
        const path = commandPath(quote);
        // `lh --help` names the root help rather than a subcommand, so it has no entry to resolve.
        if (path.length === 0) continue;
        quoted += 1;

        const where = `${language} ${contract}: ${quote}`;
        const entry = commandHelpForQuotedPath(path);
        expect(entry, where).toBeDefined();
        for (const flag of commandFlags(quote)) {
          expect(entry?.details ?? "", `${where} — ${flag}`).toMatch(
            new RegExp(`${flag}(?![\\w-])`, "u"),
          );
        }
      }
      // An extractor that stopped matching would satisfy every assertion above by finding nothing.
      expect(quoted, `${language} ${contract}`).toBeGreaterThan(0);
    }
  }
});
