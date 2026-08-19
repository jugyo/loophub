import type { WorkflowContractLanguage } from "./contracts.ts";

export interface PrTestMapPromptInput {
  repo: string;
  prNumber: number;
  language?: unknown;
}

// "Generate test map" instructions injected directly into the launched agent (#348, same
// prompt-injection approach as New issue, Create PR on GitHub, and the change map). The agent reads
// the PR's base…HEAD diff and the test files in it, copies the code out verbatim, and hands the
// git/DB orchestration to the one command `lh pr test-map create`.
//
// The document's prose follows the configured application language, while its keys stay English:
// they are the schema, not prose (AGENTS.md — "Localize prose, not document structure").
//
// The defining requirement is that `code` and `target.code` are copied out of the files at the
// head, never written from memory. A map whose excerpts are paraphrases is worse than no map: it
// reads exactly like the real thing while showing tests that do not exist.
const SCHEMA = `{
  "version": 1,
  "summary": "<one line: what this PR's tests cover>",
  "files": [
    {
      "path": "<repo-relative path of the test file>",
      "tests": [
        {
          "suites": ["<outer describe>", "<inner describe/context>"],
          "title": "<the test's own title>",
          "summary": "<one line: what this test verifies>",
          "code": "<verbatim excerpt of the test, copied from the file>",
          "target": {
            "path": "<repo-relative path of the implementation under test>",
            "code": "<verbatim excerpt of that implementation, copied from the file>"
          }
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
  if (language === "ja") {
    return `LoopHub PR #${n}（repo: ${repo}）の **test map** を生成し、保存して停止してください。test map は、その PR が追加・変更したテストが何を検証しているかの一覧で、読み手は diff を読まずにテストだけを読んで PR の内容を把握します。source の変更・commit・merge・review は一切行わないでください。

**中心的な性質: \`code\` と \`target.code\` は実ファイルから逐語的にコピーしてください。** 記憶や推測で書き起こしたコードは、実在しないテストを本物のように見せるだけで、抜粋が無いより有害です。

手順:

1. \`lh pr view ${n} --repo ${repo} --json\` で PR を読み、\`base\` / \`head\` の ref と SHA を確認します。
2. \`git diff --numstat <base sha>...<head sha>\` で変更ファイルの一覧を取り、その中のテストファイルを特定します。
3. 各テストファイルを **head の内容そのまま** 読みます（\`git show <head sha>:<path>\` など）。この PR で追加・変更されたテストを 1 つ残らず拾ってください。
4. テストごとに、\`suites\`（describe / context の階層。無ければ空配列）、\`title\`、何を検証しているかの \`summary\`、そしてテスト本体の \`code\` を書きます。\`code\` は読み取ったファイルからの逐語コピーで、インデントもそのまま維持します。
5. そのテストが検証している実装が特定できる場合は \`target\` に実装のパスと、その実装の逐語的な抜粋を入れます。特定できない場合は \`target\` を省略してください（当て推量で埋めない）。
6. 下記のスキーマの JSON document を書きます。**キーは英語のまま維持し、\`summary\` などの散文はアプリケーションで選択されている言語に従って日本語で記述してください。** code、identifier、command、path、引用した log / error text は原文のまま維持します。
7. \`lh pr test-map create ${n} --repo ${repo} --head-sha <head sha> --body -\` で保存します（document は heredoc で stdin から渡します）。この 1 コマンドが検証・保存・イベント発火を行います。document が壊れている場合は 422 で拒否されるので、その場で直して再実行してください。
8. 何ファイル・何テストを載せたか、意図的に省いたテストファイルがあればそれを報告して**停止**します。

スキーマ:

\`\`\`json
${SCHEMA}
\`\`\`

書き方の指針:

- **変更されたテストファイルは 1 つ残らず \`files\` に入れてください。** 載っていないテストファイルは UI 上で「Not covered」として表示されます。
- \`summary\` は「何を検証しているか」を 1 行で書きます。テスト名の言い換えではなく、そのテストが守っている性質を書いてください。
- \`code\` の抜粋は、そのテストが何をしているか分かる最小限の範囲にします。ファイル全体を貼らないでください。setup が理解に必要なら、その行だけを含めて構いません。
- \`target.code\` も同様に、テストが呼んでいる関数やコンポーネントの本体など、対象が分かる範囲に絞ります。
- テストを実行する必要はありません。この作業は読むだけです。`;
  }
  return `Generate and save the **test map** for LoopHub PR #${n} (repo: ${repo}), then stop. A test map lists what the tests this PR added or changed verify, so a reader can read the tests alone — without the diff — and come away knowing what the PR did. Do not modify source, commit, merge, or review anything.

**The defining property: \`code\` and \`target.code\` are copied verbatim out of the real files.** An excerpt written from memory is worse than none: it reads exactly like the real thing while showing a test that does not exist.

Steps:

1. Read the PR with \`lh pr view ${n} --repo ${repo} --json\` — its \`base\` / \`head\` refs and SHAs.
2. List the changed files with \`git diff --numstat <base sha>...<head sha>\` and pick out the test files among them.
3. Read each test file **as it stands at the head** (\`git show <head sha>:<path>\`, for example). Account for every test this PR added or changed.
4. For each test write its \`suites\` (the describe / context titles above it, outermost first; an empty array when there are none), its \`title\`, a \`summary\` of what it verifies, and its \`code\` — copied verbatim from the file you just read, indentation included.
5. When the implementation a test exercises can be pointed at, put its path and a verbatim excerpt of it in \`target\`. Leave \`target\` out when it cannot; do not guess one.
6. Write a JSON document in the schema below. **Keep the keys in English and write the prose values in the language selected in the application, which is English.** Keep code, identifiers, commands, paths, and quoted log or error text in their original form.
7. Save it with \`lh pr test-map create ${n} --repo ${repo} --head-sha <head sha> --body -\` (pipe the document in via stdin with a heredoc). That one command validates, stores, and emits its event. A malformed document is rejected with a 422 naming the problem — fix it and run the command again.
8. Report how many files and tests the map lists, and any test file you deliberately left out, then **stop**.

Schema:

\`\`\`json
${SCHEMA}
\`\`\`

How to write it:

- **Every changed test file belongs in \`files\`.** One the map leaves out is shown to the reader as "Not covered".
- A \`summary\` says what the test verifies in one line. Write the property it protects, not a restatement of its title.
- Keep each \`code\` excerpt to the smallest span that shows what the test does. Do not paste whole files; include a setup line only where the test is unreadable without it.
- Keep \`target.code\` to the same scale — the function or component body the test calls, enough to see what is under test.
- Do not run the tests. This is a reading task.`;
}

/** Return the "Generate test map" prompt, falling back to English for unknown settings. */
export function prTestMapPrompt(input: PrTestMapPromptInput): string {
  const language: WorkflowContractLanguage =
    input.language === "ja" ? "ja" : "en";
  return render(language, input.repo, input.prNumber);
}
