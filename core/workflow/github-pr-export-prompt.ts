import type { WorkflowContractLanguage } from "./contracts.ts";

export interface GithubPrExportPromptInput {
  repo: string;
  prNumber: number;
  language?: unknown;
}

// "Create PR on GitHub" filing instructions injected directly into the launched agent (same
// prompt-injection approach as the New issue button, #1892), replacing the retired
// /lh-create-github-pr skill. The agent still hands the git/gh/record orchestration to the one
// atomic command `lh pr create-github-pr`; this prompt only carries the LLM work (branch name,
// title, body) plus the double-create guard and the post-create verification GET.
//
// The GitHub title/body follow the configured application language, matching every other generated
// artifact launched from the UI.
function render(
  language: WorkflowContractLanguage,
  repo: string,
  n: number,
): string {
  if (language === "ja") {
    return `LoopHub PR #${n}（repo: ${repo}）を GitHub の Draft PR として作成し、LoopHub に記録し直してから停止してください。GitHub PR のマージ・レビューは行わず、他のスキルへ連鎖しないでください。

手順:

1. \`lh pr view ${n} --repo ${repo} --json\` で LoopHub PR を読みます。\`github_pull\` が既に非 null なら、その GitHub PR の URL/番号を報告して**停止**します（二重作成防止。UI は既にサイドバーの GitHub PR セクションにその GitHub PR へのリンクを表示しています）。生成の文脈として \`title\` / \`body\` / \`linked_issue\` を、モードは \`merge_mode\`（\`github_pr\` を想定）を確認します。
2. \`gh auth status\` で GitHub CLI が認証済みか確認します。未認証なら停止し、\`gh auth login\` の実行をユーザーに依頼します。
3. 変更内容を反映した短い content-based の branch 名を選びます（\`type/slug\` 形式、小文字・ハイフン・ASCII）。内部の \`loophub/issue-<n>\` branch は使いません。
4. GitHub PR の title と body を書きます。**アプリケーションで選択されている言語に従い、自然言語部分は日本語で記述してください。対象の PR / 変更内容から別の言語を推測しないでください。code、identifier、command、path、引用した log / error text は翻訳せず原文のまま維持してください。** repo に PR テンプレート（\`.github/PULL_REQUEST_TEMPLATE.md\` など）があればそのセクションを実際の内容で埋めます。LoopHub の定型文・\`Closes #<n>\`・Evidence ブロックは含めません。
5. \`lh pr create-github-pr ${n} --repo ${repo} --branch "<branch>" --title "<title>" --body -\` を実行します（body は heredoc で stdin から渡します）。このコマンドが branch の push・Draft PR の open・LoopHub への記録を atomic に行います。\`git push\` / \`gh pr create\` / \`lh pr record-github-pr\` を手動実行したり worktree へ \`cd\` したりしないでください。
6. 作成後、\`lh pr view ${n} --repo ${repo} --json\` を GET して \`github_pull\` が非 null（number + url）になったことを確認します。これが PR 詳細から「Create PR on GitHub」ボタンを消し、サイドバーに GitHub PR へのリンク付き見出しを出す条件です。
7. GitHub PR の URL と番号（Draft）、push した branch 名を報告して**停止**します。GitHub PR のマージ・レビュー・ready 化は行いません。`;
  }
  return `Create LoopHub PR #${n} (repo: ${repo}) as a GitHub Draft PR, record it back into LoopHub, then stop. Do not merge or review the GitHub PR, and do not chain to other skills.

Steps:

1. Read the LoopHub PR with \`lh pr view ${n} --repo ${repo} --json\`. If \`github_pull\` is already non-null, report that GitHub PR's URL/number and **stop** (double-create guard — the UI's sidebar GitHub PR section already links to that GitHub PR). Use \`title\` / \`body\` / \`linked_issue\` as generation context and check \`merge_mode\` (expected \`github_pr\`).
2. Confirm the GitHub CLI is authenticated with \`gh auth status\`. If it is not, stop and ask the user to run \`gh auth login\`.
3. Choose a short, content-based branch name reflecting the change (\`type/slug\`, lowercase, hyphenated, ASCII). Do not use the internal \`loophub/issue-<n>\` branch.
4. Write the GitHub PR title and body. **Follow the language selected in the application and write their natural-language content in English. Do not infer a different language from the target PR or change. Keep code, identifiers, commands, paths, and quoted log or error text in their original form.** If the repo has a PR template (e.g. \`.github/PULL_REQUEST_TEMPLATE.md\`), fill its sections with real content. Do not include LoopHub boilerplate, a \`Closes #<n>\` line, or an Evidence block.
5. Run \`lh pr create-github-pr ${n} --repo ${repo} --branch "<branch>" --title "<title>" --body -\` (pipe the body in via stdin with a heredoc). This command pushes the branch, opens the Draft PR, and records it back into LoopHub atomically. Do not hand-run \`git push\` / \`gh pr create\` / \`lh pr record-github-pr\`, and do not \`cd\` into the worktree.
6. After creation, GET the PR again with \`lh pr view ${n} --repo ${repo} --json\` and confirm \`github_pull\` is now non-null (number + url). That is what removes the PR detail's "Create PR on GitHub" button and gives the sidebar's GitHub PR section a heading that links to the GitHub PR.
7. Report the GitHub PR URL and number (Draft) and the pushed branch name, then **stop**. Do not merge, review, or mark the GitHub PR ready.`;
}

/** Return the "Create PR on GitHub" filing prompt, falling back to English for unknown settings. */
export function githubPrExportPrompt(input: GithubPrExportPromptInput): string {
  const language: WorkflowContractLanguage =
    input.language === "ja" ? "ja" : "en";
  return render(language, input.repo, input.prNumber);
}
