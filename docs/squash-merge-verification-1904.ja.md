# squash マージ経路の検証 (#1904)

## 結論

- Web の Merge UI で選んだ `squash` は、途中で書き換えられることなく `core/git.ts` の
  `mergePull(method: "squash")` に到達する。CLI `lh pr merge --method squash` も同じ手続きに入る。
- squash の結果は **base を唯一の親とする 1 コミット**であり、head の複数コミットはそこに圧縮される。
  head の元コミットは base の履歴に入らず、分岐後に base 側が進めた変更は保持される。
  base と head が実際に分岐した repo での実測で確認済み（[実測](#実測-2026-07-25)）。
- `merge`（2 親のマージコミット）と `rebase`（線形・コミット数維持）とは結果が明確に異なる。
- 乖離 1 件（squash の正しさではなく入力検証の話）: CLI は `--method` の値を検証しない。
  未知の値は `mergePull` の `else` 分岐に落ちて **squash として実行される**。RPC 経路は enum で弾く。

## 経路: Web Merge UI → core

| # | 場所 | 事実 |
|---|------|------|
| 1 | `web/src/components/pull-detail.tsx:61` | 選択肢は `["squash", "merge", "rebase"]` の定数。 |
| 2 | `web/src/components/pull-detail.tsx:263` | `method` state の初期値が `"squash"`。 |
| 3 | `web/src/components/pull-detail.tsx:395-407` | `<select aria-label="Merge method">` の `value`/`onChange` が同 state に直結。option の `value` は方式名そのもの。 |
| 4 | `web/src/components/pull-detail.tsx:414` | Merge ボタンは `merge.mutate(method, …)`。state をそのまま渡す。 |
| 5 | `web/src/queries/pulls.ts:152-153` | `mutationFn: (mergeMethod) => mergePull(owner, repo, number, mergeMethod)`。変換なし。 |
| 6 | `web/src/api/client.ts:865-878` | RPC `pulls/merge` の params に `merge_method: mergeMethod` として載せる。 |
| 7 | `web/server/rpc.ts:10,13,99-107` | params は Ajv で contract schema 検証。schema 外の値は `Invalid params`。 |
| 8 | `web/server/contract.ts:925` | `merge_method: { enum: ["squash", "merge", "rebase"] }`。 |
| 9 | `web/server/contract.ts:931-937` | `svc.pulls.merge(p.repo, p.number, p.merge_method ?? "squash", p.session_id)`。未指定時のみ squash に既定。 |
| 10 | `core/service/pulls.ts:614-650` | `method` を素通しで `gitMergePull(local_path, base_ref, head_ref, method, message, actor)` へ。 |
| 11 | `core/service/shared.ts:43` | `gitMergePull` は `core/git.ts` の `mergePull` の再エクスポート。 |

マージ後、同じ `method` が DB にも記録される: `core/service/pulls.ts:658` → `core/store/pulls.ts:316,341-345`
（`pulls.merge_method` カラム: `core/db.ts:183`）。

## 経路: CLI

- `cli/args.ts:45,142` — `--method` は文字列フラグとして宣言。
- `cli/commands/pr.ts:135-142` — `s.pulls.merge(repo, Number(rest[0]), (flags.method || "squash") as any, …)`。
  Web と同じ `core/service/pulls.ts` の手続きに入る。既定は squash。
- ただし `as any` で値検証がない。`--method bogus` は `mergePull` の `method === "rebase"` 分岐に入らず、
  `method === "merge"` でもないため親は `["-p", baseSha]` になり、squash と同じ結果になる
  (`core/git.ts:576-577`)。エラーにはならない。

## squash の実装

`core/git.ts:544-591`（`mergePull`）:

- `core/git.ts:573-575` — `mergePreview()` = `git merge-tree --write-tree base head`
  (`core/git.ts:475-490`) でマージ済みツリーを得る。コンフリクトならここで打ち切り。
- `core/git.ts:576-577` — 親の決定はここ 1 箇所:
  `method === "merge" ? ["-p", baseSha, "-p", headSha] : ["-p", baseSha]`。
  squash は **base 1 つだけ**を親にする。
- `core/git.ts:584-590` — `git commit-tree <merged tree> -p <baseSha> -m <message>` で 1 コミット生成。
  head のコミット列は親として参照されないため、履歴上は 1 コミットに圧縮される。
- `core/git.ts:593-598` — `git update-ref refs/heads/<base> <new> <old>` で base を前進（fast-forward）。

`rebase` だけが別分岐で、`git replay --onto base base..head` (`core/git.ts:562-571`) の結果 sha を base に据える。

## 実測 (2026-07-25)

分岐点 `base` の上に head が 2 コミット、その後 base 側も `base 2` を 1 コミット進めて **base と head が
実際に分岐している** 一時 repo（`core/git.test.ts:248` の `makeDivergedRepo()` と同じ構成）に対し、
`mergePull` を 3 方式で実行した結果:

```
===== method=squash merged=true
branch point = 7724776 / base before = 24e3b0e (base moved past the branch point) / head before = e7ae44d
main tip parents (count=1): 24e3b0e
main commit count = 3 (base had 2)
diff base..main = a.txt, b.txt
head's own commits reachable from main? false
base-only file c.txt still present? true
ee99e52 parents=[24e3b0e] feat (#1)
24e3b0e parents=[7724776] base 2
7724776 parents=[] base

===== method=merge merged=true
branch point = 7724776 / base before = 4f898b0 / head before = 55fa9ed
main tip parents (count=2): 4f898b0, 55fa9ed
main commit count = 5 (base had 2)
head's own commits reachable from main? true
bc2c46c parents=[4f898b0 55fa9ed] feat (#1)
4f898b0 parents=[7724776] base 2
55fa9ed parents=[b710a80] feat 2
b710a80 parents=[7724776] feat 1
7724776 parents=[] base

===== method=rebase merged=true
branch point = 7a670e7 / base before = e5d76bf / head before = 0410d8e
main tip parents (count=1): a908be8
main commit count = 4 (base had 2)
head's own commits reachable from main? false   # 元の head sha ではなく replay された新 sha
9bf5c78 parents=[a908be8] feat 2
a908be8 parents=[e5d76bf] feat 1
e5d76bf parents=[7a670e7] base 2
7a670e7 parents=[] base
```

- squash: 親は base（`24e3b0e`）1 つだけ。base の 2 コミットに 1 コミットだけ足されており（count 2 → 3）、
  head の 2 コミットが 1 つに圧縮されている。`diff base..main` は head が入れた `a.txt`/`b.txt` の全件、
  かつ base 側だけの `c.txt` も残るので、squash コミットのツリーは base と head の両方を含む。
  head の元コミットは main から到達できない。
- merge: 親は base と head の 2 つ、head の元コミットがそのまま main の履歴に入る（count 5）。
- rebase: 線形（親 1 つ）で head の 2 コミットが別コミットとして残る（count 4）。replay により sha は
  書き換わるため、元の head sha は main から到達できない。

3 方式は親数・コミット数・head コミットの到達可否で明確に区別できる。

## 自動テスト

`core/git.test.ts` に追加（`npm run test:integration` 対象）:

- `core/git.test.ts:292` `squash merge adds one commit whose only parent is base`
  — 親が `[baseSha]` のみ、コミット数 +1、head の元コミットが base の祖先でないこと、
  `git diff base main` が head の変更ファイル全件と一致すること、base 側の変更が残ることを検証。
- `core/git.test.ts:321` `merge keeps two parents and rebase stays linear`
  — merge は親が `[baseSha, headSha]`・コミット数 +3、rebase は `rev-list --merges` が空・コミット数 +2。
- `core/git.test.ts:248` `makeDivergedRepo()` — 分岐後に base も進む repo を作り、3 方式の差が出る状態を用意。

既存の `core/git.test.ts:185,218` は squash を使うが index.lock リトライの検証であり、
親数・履歴は検証していなかった。

## 検証コマンド

```sh
rg -n 'const \[method, setMethod\] = useState<MergeMethod>' web/src/components/pull-detail.tsx
rg -n 'merge_method: mergeMethod' web/src/api/client.ts
rg -n 'merge_method: \{ enum' web/server/contract.ts
rg -n 'p.merge_method \?\? "squash"' web/server/contract.ts
rg -n 'await gitMergePull' core/service/pulls.ts
rg -n 'method === "merge" \? \["-p", baseSha, "-p", headSha\] : \["-p", baseSha\]' core/git.ts
rg -n 'flags.method \|\| "squash"' cli/commands/pr.ts
npm run test:integration -- core/git.test.ts
```
