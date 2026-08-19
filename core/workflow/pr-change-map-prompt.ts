import { CHANGE_MAP_MAX_CATEGORIES } from "../change-map-document.ts";
import type { WorkflowContractLanguage } from "./contracts.ts";

export interface PrChangeMapPromptInput {
  repo: string;
  prNumber: number;
  language?: unknown;
}

// "Generate change map" instructions injected directly into the launched agent (#344, same
// prompt-injection approach as New issue and Create PR on GitHub). The agent reads the PR's whole
// base…HEAD diff and its tests, writes the map as a document, and hands the git/DB orchestration to
// the one command `lh pr map create`.
//
// The document's prose follows the configured application language, while its keys stay English:
// they are the schema, not prose (AGENTS.md — "Localize prose, not document structure").
//
// The defining requirement is coverage: a diff that cannot be reached from the map is a hole in
// the map, not an omission from a summary. Because each change declares the files it covers,
// "reachable" is exact — nothing blocks a map with holes (the PR detail offers whatever is left
// over as Not covered), but the prompt asks for none.
const SCHEMA = `{
  "version": 1,
  "summary": "<one line: what this PR did>",
  "categories": [
    {
      "name": "<category name>",
      "summary": "<one line>",
      "changes": [
        {
          "name": "<change name>",
          "kind": "<migration | domain logic | JSON-RPC method | CLI command | UI component | docs | …>",
          "summary": "<what this change does>",
          "files": [
            "<repo-relative path>",
            { "path": "<repo-relative path>", "summary": "<optional: what this change did to this one file>" }
          ],
          "tests": "<optional: what verifies this, and what is left uncovered>",
          "risk": "<optional: what a reviewer should look at>"
        }
      ]
    }
  ]
}`;

function render(
  language: WorkflowContractLanguage,
  repo: string,
  n: number,
): string {
  const max = CHANGE_MAP_MAX_CATEGORIES;
  if (language === "ja") {
    return `LoopHub PR #${n}（repo: ${repo}）の **change map** を生成し、保存して停止してください。change map は PR の変更全体を覆う構造化された地図で、読み手はまず全体像を掴み、そこから興味を持った diff へ降りていきます。source の変更・commit・merge・review は一切行わないでください。

**中心的な性質: change map から辿れない diff があってはなりません。** 地図に載っていない土地があること自体が欠陥です。単なる要約ではありません。

手順:

1. \`lh pr view ${n} --repo ${repo} --json\` で PR を読み、\`base\` / \`head\` の ref と SHA、linked issue、既存の body を確認します。
2. \`git diff --numstat <base sha>...<head sha>\` で変更ファイルの一覧を取り、\`git diff <base sha>...<head sha>\` の全体を読みます。**変更されたファイルを 1 つ残らず確認してください。** テストファイルも同様に読み、何を検証しているかを把握します。
3. 下記のスキーマの JSON document を書きます。**キーは英語のまま維持し、値の散文はアプリケーションで選択されている言語に従って日本語で記述してください。** code、identifier、command、path、引用した log / error text は原文のまま維持します。
4. **変更ファイルは 1 つ残らず、いずれかの change の \`files\` に入れてください。** ここが唯一の到達経路です。\`files\` は repo からの相対パスをそのまま書きます（\`git diff --numstat\` が出力する形）。どの change にも属さないファイルは、UI 上で「Not covered」として地図の欠落として表示されます。
5. \`lh pr map create ${n} --repo ${repo} --head-sha <head sha> --body -\` で保存します（document は heredoc で stdin から渡します）。この 1 コマンドが検証・保存・イベント発火を行います。document が壊れている場合は 422 で拒否されるので、その場で直して再実行してください。
6. 変更ファイル何件をカバーしたか、意図的に触れなかったものがあればそれを報告して**停止**します。

スキーマ:

\`\`\`json
${SCHEMA}
\`\`\`

分類の指針:

- **カテゴリは最大 ${max} 個**です。上限であって目標ではありません。3〜5 個を目安に、迷ったら少ないほうへ寄せてください。${max + 1} 個目が欲しくなったら分けすぎです。統合して、その区別はカテゴリ内の change として残してください。カテゴリ数が上限を超える document は保存時に拒否されます。
- \`core/\` \`cli/\` \`web/\` のようにディレクトリ構造をなぞった分類にしないでください。それはファイル一覧の言い換えであって抽象化ではありません。**その変更が何を成し遂げたか**でまとめてください。
- 「その他」「雑多」のような捨て場カテゴリを作らないでください。行き場のない変更が出るのは、たいてい他のカテゴリの括り方が狭すぎるためです。
- change は「1 つのまとまった仕事」の単位です。実装とそのテストは同じ change に入れてください（\`tests\` にそのテストが何を検証しているかを書きます）。
- \`risk\` は本当に見るべき点がある change にだけ付けてください。全部に付けると意味を失います。
- \`files\` の要素は、パスの文字列そのままか、\`{ "path": …, "summary": … }\` のどちらでも構いません。
  \`summary\` はそのファイルの diff の上に表示される任意の一行です。**そのファイル固有に言うことがあるときだけ**
  付けてください（変更単位の説明の繰り返しにしない）。ほとんどのファイルは文字列のままで構いません。`;
  }
  return `Generate and save the **change map** for LoopHub PR #${n} (repo: ${repo}), then stop. A change map is the structured map covering the PR's whole change: a reader takes in the overall shape from it first, then descends into whichever diffs they became interested in. Do not modify source, commit, merge, or review anything.

**The defining property: no diff may be unreachable from the change map.** Land missing from the map is a defect in the map. This is not a summary.

Steps:

1. Read the PR with \`lh pr view ${n} --repo ${repo} --json\` — its \`base\` / \`head\` refs and SHAs, the linked issue, and the existing body.
2. List the changed files with \`git diff --numstat <base sha>...<head sha>\`, then read the whole of \`git diff <base sha>...<head sha>\`. **Account for every changed file, without exception.** Read the tests too, and work out what each one verifies.
3. Write a JSON document in the schema below. **Keep the keys in English and write the prose values in the language selected in the application, which is English.** Keep code, identifiers, commands, paths, and quoted log or error text in their original form.
4. **Every changed file must appear in some change's \`files\`.** That is the only route to its diff. Write paths repo-relative, exactly as \`git diff --numstat\` prints them. Any file that belongs to no change is shown to the reader as "Not covered" — a hole in the map.
5. Save it with \`lh pr map create ${n} --repo ${repo} --head-sha <head sha> --body -\` (pipe the document in via stdin with a heredoc). That one command validates, stores, and emits its event. A malformed document is rejected with a 422 naming the problem — fix it and run the command again.
6. Report how many changed files the map covers, and anything you deliberately left out, then **stop**.

Schema:

\`\`\`json
${SCHEMA}
\`\`\`

How to group:

- **At most ${max} categories.** That is a ceiling, not a target — aim for three to five, and when torn, choose fewer. Wanting a ${max + 1}th means you are splitting too finely: merge, and keep the distinction as separate changes inside a category. A document with more categories than the ceiling is rejected on save.
- Do not group by directory (\`core/\`, \`cli/\`, \`web/\`). That renames the file list instead of abstracting over it. Group by **what the change accomplished**.
- Do not create a "Misc" or "Other" catch-all. Changes with nowhere to go usually mean the other categories are drawn too narrowly.
- A change is one coherent piece of work. Keep an implementation and its tests in the same change, and say in \`tests\` what those tests verify.
- Use \`risk\` only where there is genuinely something to look at. On every change it stops meaning anything.
- An entry in \`files\` may be the bare path or \`{ "path": …, "summary": … }\`. That \`summary\` is an optional
  line shown above that file's diff — add one **only when there is something specific to say about that
  file**, not to restate the change. Most files stay bare strings.`;
}

/** Return the "Generate change map" prompt, falling back to English for unknown settings. */
export function prChangeMapPrompt(input: PrChangeMapPromptInput): string {
  const language: WorkflowContractLanguage =
    input.language === "ja" ? "ja" : "en";
  return render(language, input.repo, input.prNumber);
}
