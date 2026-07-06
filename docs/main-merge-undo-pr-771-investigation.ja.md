# PR 771 の main merge undo 表示調査

## 結論

PR #771 で `Recorded commit has 1 parent(s), not a merge commit` が表示された直接原因は、
PR #771 の記録済みマージ方式が `squash` であり、記録済みコミット
`875ff5496c07aba796f971f9ccd145706a9ab65e` が 1 親コミットだったため。

`undo-main-merge` は `main` の先頭が PR の記録済みマージコミットと一致し、そのコミットが
2 親の merge commit である場合だけ自動 undo を許可する。squash merge は 1 親コミットなので、
`main` がまだ記録済み SHA を指していても undo 対象外になる。

## トリガー条件

このメッセージは PR 詳細の `main_merge_undo` 状態、または `lh pr undo-main-merge` の実行時に
`core/main-merge-undo.ts` の `assessMainMergeUndo` で判定される。

対象 PR が次の条件を満たすと表示される。

- PR が merged 状態である
- base ref が `main` である
- PR に `merge_commit_sha` が記録されている
- 現在の `main` がその `merge_commit_sha` を指している
- その記録済みコミットの親数が 2 ではない

## PR 771 の確認手順

PR の表示状態:

```sh
lh pr view 771 --repo jugyo/loophub --json
```

確認できた要点:

```json
{
  "merged": true,
  "merge_commit_sha": "875ff5496c07aba796f971f9ccd145706a9ab65e",
  "main_merge_undo": {
    "current_main_sha": "875ff5496c07aba796f971f9ccd145706a9ab65e",
    "merge_commit_sha": "875ff5496c07aba796f971f9ccd145706a9ab65e",
    "previous_main_sha": "1e9b3e190eed3746b879794fdb0ea2f4b1ccaebb",
    "can_undo": false
  }
}
```

DB 上の記録済みマージ方式:

```sh
node --experimental-sqlite --disable-warning=ExperimentalWarning -e 'const { DatabaseSync } = require("node:sqlite"); const home = process.env.LOOPHUB_HOME ?? `${process.env.HOME}/.loophub`; const dbPath = process.env.LOOPHUB_DB ?? `${home}/loophub.db`; const db = new DatabaseSync(dbPath); const row = db.prepare(`select i.number, p.merge_commit_sha, p.merge_method from issues i join pulls p on p.issue_id = i.id join repos r on r.id = i.repo_id where r.owner = ? and r.name = ? and i.number = ?`).get("jugyo", "loophub", 771); console.log(JSON.stringify(row, null, 2));'
```

確認できた要点:

```json
{
  "number": 771,
  "merge_commit_sha": "875ff5496c07aba796f971f9ccd145706a9ab65e",
  "merge_method": "squash"
}
```

記録済みコミットの親数:

```sh
git rev-list --parents -n 1 875ff5496c07aba796f971f9ccd145706a9ab65e
```

出力:

```text
875ff5496c07aba796f971f9ccd145706a9ab65e 1e9b3e190eed3746b879794fdb0ea2f4b1ccaebb
```

SHA が 2 個だけなので、最初が対象コミット、2 個目が唯一の親コミットである。つまり親数は 1。

## 既知の動作

これは履歴比較ロジックの失敗ではなく、`undo-main-merge` の安全条件による拒否である。
2 親 merge commit なら第 1 親へ `main` を戻せるが、squash merge の 1 親コミットでは PR の
head 側の親が記録済みコミットに存在しないため、この undo 操作では扱わない。

## メッセージ改善

従来の文言は親数だけを示していたため、PR #771 のような squash merge では原因が分かりにくかった。
今後は記録済み `merge_method` がある場合、その方式を含めて次のように表示する。

```text
Recorded squash merge commit has 1 parent(s); undo-main-merge only supports two-parent merge commits
```
