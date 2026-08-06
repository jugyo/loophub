# PR #2420: Changed Files に無関係ファイルが残る原因

## 結論

#2419 が直した「fork point との two-dot」とは別に、**local `base_ref` が remote tip より遅れている状態で `origin/<base>` を head にマージしたとき**、three-dot / live merge-base が stale な local tip を基準にするため、remote 側だけで進んだファイルが Changed Files に残る。

## 再現（実データ）

`bringout/shota-project-hub` PR #26（issue #2417 の報告例）:

| 比較 | 結果 |
| --- | --- |
| local `main` | `cebcc645` |
| `origin/main` | `d5c30046`（local より先行） |
| head の merge | `7f0bba05 Merge remote-tracking branch 'origin/main'` |
| `main...head` | 25 files（custom-dashboard / read-api 等を含む） |
| `origin/main...head` | 3 files（insight-signals の PR 固有変更のみ） |

local `main` が `origin/main` に追いついていないことが直接の原因。

## 経路と基準（実装）

### UI の Files changed リスト

- `web/src/components/pull-detail.tsx:100` — `usePullFiles`
- `web/src/queries/pulls.ts:118-128` — `listPullFiles` → RPC `pulls/files`
- `core/service/page-data.ts:85` — `pullDetail` も `pulls.files`
- **修正前** `core/service/pulls.ts` `files()` — `diffFiles(local_path, base_ref, head_ref)`
- `core/git.ts:184-191` — `diffFiles` は `base...head`（three-dot）

three-dot 自体は正しいが、左辺が **local `base_ref` のみ**。

### ファイル内容 / CLI `lh pr diff`

- `core/service/pulls.ts` `diff()` — `resolvePullDiffBaseSha` + `diffFilesBetween`
- **#2419 修正後** `core/pull-base.ts` — `mergeBase(base_ref, head_ref)` のみ
  - fork point two-dot は解消
  - local が stale なときは merge-base も local tip のまま → 同症状が残る

### fork point（別物）

- `core/pull-base.ts` `resolvePullBaseSha` — 作成時の `pulls.base_sha`（並行 attempt 用）
- wire の `base_sha` は fork point（`core/serialize-status.ts:403`）
- live Files-changed の左辺ではない

## 修正方針

`resolvePullDiffBaseSha` が次を候補にし、head との merge-base がより新しい方（他方の descendant）を採用する:

1. `base_ref`（local）
2. `refs/remotes/origin/<base_ref>`（存在時）

`pulls.files` も同じ `resolvePullDiffBaseSha` + `diffFilesBetween` に揃え、UI リストと `pulls.diff` を一致させる。

## テスト証拠（引用の存在確認）

```sh
# 修正対象の定義
rg -n "resolvePullDiffBaseSha|refs/remotes/origin" core/pull-base.ts
rg -n "async files|resolvePullDiffBaseSha|diffFilesBetween" core/service/pulls.ts
rg -n "usePullFiles|pulls/files" web/src/components/pull-detail.tsx web/src/queries/pulls.ts web/server/contract.ts

# 回帰ケース
rg -n "origin/main-only files when local base lags|prefers origin/<base>" core
```

上記がヒットし、関連 vitest が green なら passed。
