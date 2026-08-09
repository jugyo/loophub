# issue 一覧の workflow run state を pageData に畳んだ効果（#112）

issue 一覧 / dashboard の行ごとに 1 本ずつ飛んでいた `workflowRuns/stateForPull` を、
`pageData/issueList` の応答に含める形（#123 と同じ規約）に変更したときの計測記録。

## 何が問題だったか

`LinkedPullSummaryRow` の中の `WorkflowMiniProgress` が行ごとに `useWorkflowRunForPull` を呼ぶ。
`workflow_run.*` / `workflow_step.*` event はその全行を同時に invalidate するので、
event 1 個につき「行数 × 1 本」の RPC が lh-web の単一 event loop に同時に載っていた。

## 変更後の形

- `pageData/issueList` が `workflow_runs`（行が表示する PR の run state）を返す
- `useIssueListPage` が `queryKeys.workflowRunForPull` に seed する
- 行の `useWorkflowRunForPull` は `enabled=false` で cache から読む
- `workflow_run.*` / `workflow_step.*` は issue 一覧の query を invalidate する
  （行の query は disabled なので、per-PR key だけを invalidate しても tracker は動かない）
- 単独の `workflowRuns/stateForPull` は PR 詳細など 1 件だけ要る画面のために残る

## 計測

#110（`workspaces.listUnmerged` の削除、main の 0fdbd27）を取り込んだ状態が基準。
12 issue / 12 PR / 12 workflow run を seed した合成 repository に対し、専用の `LOOPHUB_HOME` で
lh-web を 1 プロセス起動して、同じ burst を 5 回ずつ実行した median。

run state が届く経路は 2 つあるので、両方を測る。

### 1. 初回ロード

| burst | requests | median |
| --- | --- | --- |
| 変更前: `pageData/issueList` + 行ごとの `stateForPull` | 13 | 5318.6ms |
| 変更後: `pageData/issueList` のみ（run state 込み） | **1** | **3623.9ms** |

RPC 本数は行数に比例しなくなり、13 本 → 1 本。時間も -32%。

### 2. workflow event 1 個による再取得

こちらが本番で数の出る経路で、**変更後のほうが重い**。本番ログ 24h の `stateForPull` 1112 回
（`pageData/issueList` 167 回の約 6.7 倍）はこの経路。

変更前は event が `queryKeys.workflowRunForPull(repo, pr)` を invalidate していた。PR 番号を持つ
event はその行だけ、持たない event は `["workflow-run","pull",repo]` prefix で全行が refetch した。
変更後はどちらも `queryKeys.issues(repo)` の invalidate になり、`pageData/issueList` が 1 本走る。

| event 1 個あたり | requests | median |
| --- | --- | --- |
| 変更前: PR 番号を持つ event（その行だけ） | 1 | **191.7ms** |
| 変更前: PR 番号を持たない event（全行） | 12 | 1790.4ms |
| 変更後: `pageData/issueList` | 1 | **3582.8ms** |

- PR 番号を持つ event では 191.7ms → 3582.8ms（約 19 倍）
- PR 番号を持たない event では 1790.4ms → 3582.8ms（約 2 倍）

重くなる分は run state ではなく `pageData/issueList` が行ごとに回す git fan-out で、
これは #110 に続く別の削減対象（同じ表の「変更後: 初回ロード」3623.9ms のほぼ全部がこれ）。
run state 自体は行の status がすでに解決した head/base を共有するので git を増やしていない。

### この trade-off について

「`pageData` に畳む」方式は issue #112 が #123 との規約統一を理由に指定したもので、この記録は
その選択を覆すためのものではない。ただし event 経路が重くなること、そしてその重さの出どころが
`pageData/issueList` の per-row git fan-out であることは、次にどこを削るかを決めるための材料として
残しておく。invalidate の範囲は `queryKeys.issues(repo)` だけに絞ってあり（`web/src/lib/event-keys.ts`）、
issue 詳細と dashboard の行は畳み込みの対象外なので従来どおり per-PR key で更新される。

計測環境の git spawn は本番より遅い（本番ログでは `stateForPull` 単独が 104ms）。
絶対値ではなく変更前後の比を見ること。

## 再現手順

1. 専用の `LOOPHUB_HOME` に repository を 1 つ登録し、issue / PR / workflow run を 12 組作る
2. `LOOPHUB_HOME=<dir> npm run lh-web -- --port <port>`
3. burst をそれぞれ 5 回実行して median を取る:
   - 初回ロード: `pageData/issueList` 単独 / `pageData/issueList` + PR 件数ぶんの `stateForPull`
   - event 1 個: `stateForPull` 1 本 / `stateForPull` を PR 件数ぶん / `pageData/issueList` 1 本
4. RPC 本数は Chrome で一覧を開き、`/rpc` への POST body の `method` を集計して確認する
