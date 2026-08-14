# Web UI が取得するデータと RPC メソッドの棚卸し（#130）

## 目的とスコープ

Web UI（`web/src/`）が表示のために取得しているデータの種類を、使用している JSON-RPC
メソッドとあわせて一覧化する。一覧化のみを目的とし、各データの eager / lazy の扱いや
統合・削除の設計判断は行わない（#130 本文のスコープどおり、別 issue で行う）。

コード・スキーマは変更していない。本ドキュメントは調査記録であり、後の設計判断や後続
issue の入力として単体で成立させる。

## データソースと再現手順

本ドキュメントの全数値は以下の実物から取っている。再現する場合は同じ手順を踏むこと。

| 情報 | ソース | 取得方法 |
| --- | --- | --- |
| RPC メソッドの定義一覧 | `web/server/contract.ts` | `rg -o '^  "[^"]+": \{' web/server/contract.ts`（98 件 = `initialize` + 97） |
| クライアント配線一覧 | `web/src/api/client.ts` | `rg -o '"[a-zA-Z]+(/[a-zA-Z]+)+"' web/src/api/client.ts`（`application/json` 除外、94 件） |
| 生成済みコントラクト | `docs/rpc-contract.json` | `node -e '...'` で `methods.length`（98） |
| query hook の定義一覧 | `web/src/queries/*.ts` | `rg -n '^export function use'`（87 hook、14 ファイル） |
| hook の呼び出し箇所 | `web/src/components/`・`web/src/routes/` | `grep -rn '<hook>('`（`.test.*` 除外） |
| イベント・テーブル実測 | `~/.loophub/loophub.db`（この環境の HOME） | `node --experimental-sqlite` で `SELECT ... FROM events` 等 |

メソッドの「実行時に発火するか」の判定は、`client.ts` の関数が非テストの
`components/`・`routes/`・`lib/` から import されているか、query hook が実際に
mount されているか、`enabled` 引数がどう渡されているか、の三層で判定した。

## 全体像（ドライバ指標の要約）

RPC サーフェスは 4 層に分かれる。

| 層 | メソッド数 | 内訳 |
| --- | ---: | --- |
| contract 定義 | 98 | `initialize` + 97 |
| client.ts 配線 | 94 | contract のうち配線済み |
| SPA が実行時に発火 | 73 | 配線 94 − 未発火 21 |
| 未配線（contract のみ） | 4 | `diffFeedback/get` `pulls/createGithubPull` `sessions/costSummary` `sync/run` |

- **実行時に発火するメソッドは contract の 74.5%（73/98）、配線済みの 77.7%（73/94）。**
- 配線済みだが SPA から一度も呼ばれないメソッドは **21 件（配線の 22.3%）**。内訳は
  「dead client 関数 7」「dead hook 7」「pageData に畳まれて seed される詳細 hook 7」。

## カテゴリ別の一覧表

表の列は「データ」「RPC メソッド」「定義箇所（query hook / client 関数）」「実行時の扱い」。
定義箇所の行番号は本調査時点（2026-08-09）のもの。

凡例:
- **発火** = 通常の画面遷移で mount され、`enabled` が有効で実際に RPC が飛ぶ
- **seed** = pageData 応答の cache seed を読むだけ。hook は `enabled=false` で mount され、
  個別 RPC は SPA から発火しない
- **lazy** = ダイアログ等を開いたときだけ発火
- **conditional** = 条件付き（`github_pull` の有無、`github_pr` mode など）
- **dead** = 配線・定義はあるが SPA のどの画面からも呼ばれない

### Repo（`web/src/queries/repos.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| リポジトリ一覧（アクティブ） | `repos/list` | `useRepos` repos.ts:28 / `listRepos` | 発火（topbar・repo-switcher・repo-herdr-warning） |
| リポジトリ一覧（アーカイブ） | `repos/list`（archived=true） | `useArchivedRepos` repos.ts:40 / `listRepos` | 発火（`/archived`） |
| リポジトリ詳細 | `repos/get` | `useRepo` repos.ts:59 / `getRepo` | 発火（repo settings） |
| リポジトリ作成 | `repos/create` | `useCreateRepo` repos.ts:47 / `createRepo` | 発火（Add repository ダイアログ） |
| archive / unarchive | `repos/setArchived` | `useSetRepoArchived` repos.ts:70 | 発火（mutation） |
| favorite / unfavorite | `repos/setFavorite` | `useSetRepoFavorite` repos.ts:85 | 発火（mutation） |
| rename | `repos/rename` | `useRenameRepo` repos.ts:101 | 発火（mutation） |
| default branch 変更 | `repos/update` | `useSetRepoDefaultBranch` repos.ts:117 | 発火（mutation） |
| merge mode 設定（読） | `repos/mergeMode` | `useRepoMergeMode` repos.ts:131 / `getRepoMergeMode` | 発火（repo settings） |
| merge mode 設定（書） | `repos/setMergeMode` | `useSetRepoMergeMode` repos.ts:144 | 発火（mutation） |
| origin ahead/behind | `repos/originSync` | `useRepoOriginSync` repos.ts:161 / `getRepoOriginSync` | 発火（repo sidebar） |
| origin から pull | `repos/pullFromOrigin` | `usePullRepoFromOrigin` repos.ts:174 | 発火（mutation） |
| agent 設定（読） | `repos/agentConfig` | `useRepoAgentConfig` repos.ts:187 / `getRepoAgentConfig` | 発火（repo ページの statusbar・settings・start workflow） |
| agent 設定（書） | `repos/setAgentConfig` | `useSetRepoAgentConfig` repos.ts:204 | 発火（mutation） |
| GitHub PR export 追加プロンプト（読） | `repos/githubPrExportExtraPrompt` | `useRepoGithubPrExportExtraPrompt` repos.ts:222 | 発火（PR detail は github_pr mode 時のみ） |
| GitHub PR export 追加プロンプト（書） | `repos/setGithubPrExportExtraPrompt` | `useSetRepoGithubPrExportExtraPrompt` repos.ts:233 | 発火（mutation） |
| コミットの変更ファイル | `repos/commitFiles` | `useCommitFiles` pulls.ts:429 / `listCommitFiles` | lazy（commit 一覧ダイアログ） |

### Issue（`web/src/queries/issues.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| issue 一覧ページ（ページング） | `pageData/issueList` | `useIssueListPage` issues.ts:58 / `getIssueListPage` | 発火（repo top・issue list） |
| ラベル一覧 | `labels/list` | `useLabelsList` issues.ts:120 / `listLabels` | **dead**（hook がどこにも mount されない。label は pageData/issueList の includeLabels で届く） |
| issue 詳細 | `issues/get` | `useIssue` issues.ts:129 / `getIssue` | **seed**（issue detail は `enabled=false`。実体は pageData/issueDetail） |
| 本文参照の種別判定 | `issues/refKinds` | `useIssueRefKinds` issues.ts:147 / `listIssueRefKinds` | 発火（Markdown 本文に参照があるとき） |
| issue 詳細ページ（一括） | `pageData/issueDetail` | `useIssueDetailPage` issues.ts:158 / `getIssueDetailPage` | 発火（issue detail） |
| 受け入れ基準一覧 | `issues/ac/list` | `useAcceptanceCriteria` issues.ts:182 / `listAcceptanceCriteria` | **seed**（issue detail は `enabled=false`。実体は pageData/issueDetail） |
| 受け入れ基準追加 | `issues/ac/add` | `useAddAcceptanceCriterion` issues.ts:209 | 発火（mutation） |
| 受け入れ基準有効/無効 | `issues/ac/setEnabled` | `useSetAcceptanceCriterionEnabled` issues.ts:222 | 発火（mutation） |
| issue コメント一覧 | `comments/list` | `useIssueComments` issues.ts:236 / `listIssueComments` | **seed**（issue detail / PR detail とも `enabled=false`。実体は pageData） |
| コメント投稿 | `comments/create` | `usePostComment` issues.ts:250 | 発火（mutation） |
| issue 開閉 | `issues/update` | `useSetIssueState` issues.ts:269 | 発火（mutation） |
| issue 作成 | `issues/create` | `useCreateIssue` issues.ts:293 | **dead**（hook が mount されない。issue 作成は `terminal/launch` の issue-create workflow 経由） |

### Pull Request（`web/src/queries/pulls.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| PR 詳細 | `pulls/get` | `usePull` pulls.ts:51 / `getPull` | **seed**（PR detail は `enabled=false`。実体は pageData/pullDetail） |
| PR 詳細ページ（一括） | `pageData/pullDetail` | `usePullDetailPage` pulls.ts:64 / `getPullDetailPage` | 発火（PR detail） |
| PR の agent コスト使用量 | `pulls/usage` | `usePullUsage` pulls.ts:100 / `getPullUsage` | 発火（issue detail の linked PR 行） |
| PR デバッグダンプ | `pulls/debug` | `usePullDebug` pulls.ts:113 / `getPullDebug` | lazy（debug ダイアログ） |
| PR の変更ファイル一覧 | `pulls/files` | `usePullFiles` pulls.ts:127 / `listPullFiles` | **seed**（PR detail は `enabled=false`。実体は pageData/pullDetail） |
| PR の diff 本文 | `pulls/diff` | `usePullDiff` pulls.ts:184 / `getPullDiff` | lazy（diff ダイアログで file 単位） |
| diff feedback スレッド一覧 | `diffFeedback/list` | `useDiffFeedback` pulls.ts:202 / `listDiffFeedback` | 発火（PR detail の orphaned、diff ダイアログは path 単位） |
| diff feedback 作成 | `diffFeedback/create` | `useCreateDiffFeedback` pulls.ts:216 | 発火（mutation） |
| diff feedback 返信 | `diffFeedback/reply` | `useReplyDiffFeedback` pulls.ts:293 | 発火（mutation） |
| diff feedback リアクション | `diffFeedback/react` | `useReactToDiffFeedback` pulls.ts:333 | 発火（mutation） |
| diff feedback archive | `diffFeedback/archive` | `useSetDiffFeedbackArchived` pulls.ts:401 | 発火（mutation） |
| 指定 ref のファイル内容 | `pulls/fileAtRef` | `usePullFileAtRef` pulls.ts:440 / `getPullFileAtRef` | lazy（Markdown プレビュー） |
| レビュー一覧 | `reviews/list` | `usePullReviews` pulls.ts:461 / `listPullReviews` | **seed**（PR detail は `enabled=false`。実体は pageData/pullDetail） |
| ラインコメント一覧 | `reviews/listComments` | `usePullComments` pulls.ts:475 / `listPullComments` | **seed**（PR detail は `enabled=false`。実体は pageData/pullDetail） |
| PR コメント投稿 | `pullComments/create` | `usePostPullComment` pulls.ts:488 | 発火（mutation） |
| PR コメントリアクション | `pullComments/react` | `useReactToPullComment` pulls.ts:535 | 発火（mutation） |
| PR コメント archive | `pullComments/archive` | `useSetPullCommentArchived` pulls.ts:606 | 発火（mutation） |
| GitHub PR ステータス | `pulls/githubStatus` | `useGithubPrStatus` pulls.ts:637 / `getGithubPrStatus` | conditional（`github_pull` が存在するときのみ） |
| merge | `pulls/merge` | `useMergePull` pulls.ts:669 | 発火（mutation） |
| GitHub 側 merge 記録 | `pulls/markGithubMerged` | `useMarkGithubMerged` pulls.ts:686 | 発火（mutation） |
| GitHub PR へ push | `pulls/pushGithubPull` | `usePushGithubPull` pulls.ts:702 | 発火（mutation） |
| GitHub PR link 解除 | `pulls/unlinkGithubPull` | `useUnlinkGithubPull` pulls.ts:726 | 発火（mutation） |
| PR 開閉 | `pulls/update` | `useSetPullState` pulls.ts:748 | 発火（mutation） |
| archive / unarchive | `pulls/archive` `pulls/unarchive` | `useArchivePull` pulls.ts:757 / `useUnarchivePull` pulls.ts:765 | 発火（mutation） |

### Workflow / Workflow Run（`web/src/queries/workflows.ts`・`workflow-runs.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| workflow 一覧 | `workflows/list` | `useWorkflows` workflows.ts:19 / `listWorkflows` | 発火（settings/workflows・start workflow） |
| workflow contract 一覧 | `workflows/contracts` | `useWorkflowContracts` workflows.ts:36 / `getWorkflowContracts` | lazy（workflow 編集ダイアログ） |
| workflow 作成 / 更新 / archive | `workflows/create` `workflows/update` `workflows/archive` | workflows.ts:50/58/69 | 発火（mutation） |
| workflow 削除 | `workflows/delete` | client.ts `deleteWorkflow` | **dead**（client 関数が SPA から import されない） |
| run 状態（PR に紐づく） | `workflowRuns/stateForPull` | `useWorkflowRunForPull` workflow-runs.ts:17 / `getWorkflowRunStateForPull` | 発火（PR detail・issue detail・notification stack） |
| run 状態（issue に紐づく） | `workflowRuns/stateForIssue` | `getWorkflowRunStateForIssue` | **dead**（client 関数が SPA から import されない） |
| run 履歴 | `workflowRuns/history` | `useWorkflowRunHistory` workflow-runs.ts:67 | lazy（run 詳細ダイアログ） |
| run の agent コスト内訳 | `workflowRuns/agentCosts` | `useWorkflowRunAgentCosts` workflow-runs.ts:82 | lazy（run 詳細ダイアログ） |
| run の合計コスト | `workflowRuns/totalCost` | `useWorkflowRunTotalCost` workflow-runs.ts:97 | 発火（PR detail の Workflow セクション） |
| コスト上限引き上げ | `workflowRuns/increaseCostLimit` | `useIncreaseWorkflowRunCostLimit` workflow-runs.ts:38 | 発火（mutation） |

### Notification（`web/src/queries/notifications.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| 通知一覧 | `notifications/list` | `useNotifications` notifications.ts:16 / `listNotifications` | 発火（notification stack） |
| 未読通知件数 | `notifications/unreadCount` | `useUnreadNotificationCount` notifications.ts:27 / `unreadNotificationCount` | **dead**（hook が mount されない。stack は list を `unreadOnly` で引いて client 側で数える） |
| 通知を既読 | `notifications/read` | `useReadNotification` notifications.ts:34 | 発火（mutation） |
| 全既読 | `notifications/readAll` | `useReadAllNotifications` notifications.ts:92 | 発火（mutation） |

### Terminal / Agent（`web/src/queries/terminal.ts`・`sessions.ts`・`worker-status.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| herdr セッション一覧 | `terminal/sessions` | `useHerdrSessions` terminal.ts:28 / `getHerdrSessions` | 発火（常時 mount。repo-herdr-warning・notification stack・agents 等） |
| terminal workflow 起動 | `terminal/launch` | `useLaunchTerminalWorkflow` terminal.ts:13 / `launchTerminalWorkflow` | 発火（mutation） |
| herdr へフォーカス | `terminal/focusAgent` | `useFocusHerdrAgent` terminal.ts:43 | 発火（mutation） |
| herdr へ入力送信 | `terminal/sendAgentInput` | `useSendHerdrAgentInput` terminal.ts:50 | **dead**（hook が mount されない） |
| herdr 出力読み取り | `terminal/agentRead` | `getHerdrAgentRead` | **dead**（client 関数が SPA から import されない） |
| herdr プロセス kill | `terminal/killAgent` | `killHerdrAgent` | **dead**（client 関数が SPA から import されない） |
| エージェントセッション一覧 | `sessions/list` | `useAgentSessions` sessions.ts:5 / `getAgentSessions` | 発火（`/stats` Agent cost タブ） |
| worker 稼働状態 | `worker/status` | `useWorkerStatus` worker-status.ts:17 / `getWorkerStatus` | 発火（常時 mount。compat warning・start workflow の launch gate） |

### Workspace（`web/src/queries/workspaces.ts`）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| workspace 一覧 | `workspaces/list` | `useWorkspaces` workspaces.ts:21 / `listWorkspaces` | **dead**（hook が mount されない。workspace は pageData/issueList で届く） |
| アーカイブ済み workspace 一覧 | `workspaces/listArchived` | `useArchivedWorkspaces` workspaces.ts:25 | **dead**（hook が mount されない） |
| 設定画面向け workspace 一覧 | `workspaces/listForSettings` | `useSettingsWorkspaces` workspaces.ts:32 / `listSettingsWorkspaces` | 発火（repo settings > Workspaces） |
| 設定画面向けアーカイブ済み一覧 | `workspaces/listArchivedForSettings` | `useArchivedSettingsWorkspaces` workspaces.ts:39 | 発火（repo settings > Workspaces） |
| workspace 作成 | `workspaces/create` | `useCreateWorkspace` workspaces.ts:50 | 発火（mutation） |
| workspace archive | `workspaces/archive` `workspaces/unarchive` | `useSetWorkspaceArchived` workspaces.ts:65 | 発火（mutation） |

### その他（`settings.ts`・`stats.ts`・`dashboard.ts`・`search.ts`・共通）

| データ | RPC メソッド | 定義箇所 | 扱い |
| --- | --- | --- | --- |
| グローバル設定 | `settings/get` | `useSettings` settings.ts:12 / `getSettings` | 発火（bootstrap・statusbar・複数画面） |
| 設定更新 | `settings/update` | `useUpdateSettings` settings.ts:20 | 発火（mutation・theme toggle） |
| 統計情報 | `stats/get` | `useStats` stats.ts:9 / `getStats` | 発火（`/stats` DB タブ） |
| ダッシュボード概要 | `dashboard/overview` | `useRecentOpenIssues` dashboard.ts:14 / `useRecentIssuesLimit` dashboard.ts:23 | **dead**（hook が mount されない） |
| issue/PR 横断検索 | `search/query` | `useRepositorySearch` search.ts:4 / `searchIssuesAndPulls` | 発火（検索入力時のみ） |
| イベントポーリング | `events/list` | `listEvents` client.ts:165 / `useLoopHubEvents` | 発火（常時・可視時 1.5s 間隔） |
| 初期化（capability） | `initialize` | `getWebConfig` client.ts:157 | 発火（bootstrap 時 1 回） |

## 実行時に発火しないメソッドの内訳

配線済みだが SPA から発火しない 21 件は 3 種に分かれる。

### 1. dead client 関数（7）— 非テストの SPA コードから import されない

| RPC | client 関数 |
| --- | --- |
| `workflows/delete` | `deleteWorkflow` |
| `workflowRuns/stateForIssue` | `getWorkflowRunStateForIssue` |
| `terminal/agentRead` | `getHerdrAgentRead` |
| `terminal/killAgent` | `killHerdrAgent` |
| `issues/list` | `listIssues` |
| `pulls/list` | `listPulls` |
| `handoffs/list` | `listPullHandoffs` |

### 2. dead hook（7）— query hook は定義されているが、どの component も mount しない

| RPC | hook |
| --- | --- |
| `workspaces/list` | `useWorkspaces` |
| `workspaces/listArchived` | `useArchivedWorkspaces` |
| `issues/create` | `useCreateIssue` |
| `labels/list` | `useLabelsList` |
| `notifications/unreadCount` | `useUnreadNotificationCount` |
| `dashboard/overview` | `useRecentOpenIssues` / `useRecentIssuesLimit` |
| `terminal/sendAgentInput` | `useSendHerdrAgentInput` |

### 3. pageData に畳まれて seed される詳細 hook（7）— 個別 RPC は発火しない

detail 画面は `pageData/issueDetail`・`pageData/pullDetail`・`pageData/issueList` が
各データを畳み、個別 hook は `enabled=false` で cache から読む（#112/#123/#125 の畳み込み規約）。

| RPC | hook（`enabled=false`） | seed 元 |
| --- | --- | --- |
| `issues/get` | `useIssue` issue-detail.tsx:70 | `pageData/issueDetail` |
| `pulls/get` | `usePull` pull-detail.tsx:102 | `pageData/pullDetail` |
| `comments/list` | `useIssueComments` issue/pull-detail | `pageData/issueDetail` / `pageData/pullDetail` |
| `issues/ac/list` | `useAcceptanceCriteria` issue-detail.tsx:238 | `pageData/issueDetail` |
| `pulls/files` | `usePullFiles` pull-detail.tsx:103 | `pageData/pullDetail` |
| `reviews/list` | `usePullReviews` pull-detail.tsx:104 | `pageData/pullDetail` |
| `reviews/listComments` | `usePullComments` pull-detail.tsx:105 | `pageData/pullDetail` |

issue 本文のドラフト表は `issues/get` 等を「使用している」としているが、実際のネットワーク
経路は pageData 一元化であり、個別 RPC は client の wire 定義と hook が残っているだけ
というのが実態である。同じく `labels/list`・`workspaces/list`・
`notifications/unreadCount`・`dashboard/overview`・`issues/create` も issue 本文では
「使用」扱いだが、hook が mount されず実データは pageData 経由で届いている。

## dead / seed メソッドの判断（#155）

今回の 21 件は削除せず、現状の client 関数・query hook・RPC contract を維持する。

- dead client 関数と dead hook は、将来の独立取得や UI 操作を再導入する際の再利用余地を
  残す。現時点で発火しないことだけを理由に wire surface まで削る必要はない。
- seed hook は pageData の一括取得と disabled query で詳細画面を構成する現在の設計に必要な
  読み取り面である。個別 RPC を発火させないことは意図された挙動であり、hook を削除して
  component 側の参照経路を変えると、将来の独立取得や cache key の再利用を制限する。
- したがって UI の取得経路・表示挙動は変更しない。今回の判断では削除を行わないため、
  削除後の挙動差分を検証する必要もない。既存の Web テストで pageData と disabled query
  の組み合わせを継続的に確認する。

## ページ別の初期ロード RPC ファンアウト

アプリシェル（root の `useLoopHubEvents` + `AppLayout`）が常時 mount するのは
`events/list`（poll）・`repos/list`・`worker/status`・`terminal/sessions`・
`settings/get`・`notifications/list` の 6 本。ページごとの追加を足すと初期ロードの
distinct メソッド数は次のとおり（コードを trace した推計。`enabled=false` の seed hook は
カウントしない）。

| 画面 | 追加されるメソッド | 合計 |
| --- | --- | --- |
| `/`（ホーム） | なし | 6 |
| `/archived` | なし（`repos/list` の archived） | 6 |
| `/r/:owner/:repo`（repo top） | `pageData/issueList` `repos/originSync` `repos/agentConfig` | 9 |
| issue detail | `pageData/issueDetail` `pulls/usage` `workflowRuns/stateForPull` `workflows/list` `issues/refKinds`（本文参照がある場合。shell には repo ページの statusbar の `repos/agentConfig` を含む） | 12–13 |
| PR detail | `pageData/pullDetail` `workflowRuns/stateForPull` `workflowRuns/totalCost` `repos/agentConfig`（+`pulls/githubStatus`・`repos/githubPrExportExtraPrompt` は条件付き） | 10–12 |
| repo settings | `repos/get` `workspaces/listForSettings` `workspaces/listArchivedForSettings` `repos/mergeMode` `repos/agentConfig` `repos/githubPrExportExtraPrompt` | 12 |
| `/stats` | `sessions/list` `stats/get` | 8 |
| `/settings/workflows` | `workflows/list` | 7 |

`pulls/diff`・`pulls/fileAtRef`・`pulls/debug`・`repos/commitFiles`・
`diffFeedback/list`（path 単位）・`workflowRuns/history`・`workflowRuns/agentCosts`・
`workflows/contracts`・`search/query` は画面ではなくダイアログ/入力での lazy 取得。

## ポーリングとイベント量の実測

### Web 側の定期ポーリング

| 対象 | 間隔 | 根拠 |
| --- | ---: | --- |
| `events/list` | 可視時 1.5s ごと（1 タブあたり最大 2400 回/時） | `use-loophub-events.ts:12` `VISIBLE_POLL_MS = 1500`、`POLL_LIMIT = 100` |
| `worker/status` | `stale_at` まで（compatible 時は ~1 回/分） | `worker-status.ts:22` + `worker-protocol.ts:4,7`（heartbeat 5s / stale 60s） |
| `terminal/sessions` | なし（event 駆動） | `terminal.ts:19-34`、`event-keys.ts:342-347` |

`events/list` はこの環境の実測で 1 イベントあたり平均 ~151 byte（`events` テーブルの
text column 総量 2,511,877 byte ÷ 16,582 行）で、ポーリング 1 回の応答は
`POLL_LIMIT=100` 件まで。静止時は空配列が返る。

### 実 DB（`~/.loophub/loophub.db`、この環境の HOME）のイベント量

DB は常時書き込まれるため下記は調査時点のスナップショット。再計測時は件数が増える。

- `events` 総行数: 16,582（うち `jugyo/loophub` 14,118）
- 直近の 1 日あたり件数（`jugyo/loophub`）: 2026-08-05: 357 / 08-06: 2,291 /
  08-07: 2,458 / 08-08: 6,400 / 08-09: 2,612（ピーク日は ~267 件/時相当、
  5 日平均は ~2,824 件/日 ≈ ~118 件/時）
- 上位タイプ: `agent_session.usage_updated` 10,926（全体の 66%）、
  `terminal.sessions_updated` 2,309、`workflow_run.updated` 422、`pull_request.updated` 411
- DB ファイルサイズ: 21,204,992 byte（~20 MiB）。`events` が text 総量で ~2.4 MiB を占める

`agent_session.usage_updated` が過半を占めるのは、エージェント稼働中は usage counter が
数秒ごとに event を emit し、それが `events/list` ポーリングで拾われて `pulls/usage` 等を
invalidate するため（`event-keys.ts:402-404`）。

## コスト試算モデル

目的は「Web 画面 1 タブを開いたまま放置したときの RPC ボリューム」のオーダー把握。下記は
明確な前提を置いた透明なモデルであり、実測値を基にしている。前提が不確実な箇所は
レンジで示す。

### モデル式

```
RPC数/時/タブ ≒ 定期ポーリング ＋ イベント駆動 refetch
定期ポーリング    ＝ events/list（2400/時） ＋ worker/status（~60/時）
                   ≒ 2460/時（タブ可視時）
イベント駆動      ＝ events/時 × 平均 invalidation 対象 hook 数
```

### 前提（明示）

1. `events/list` はタブ可視の間 1.5s 間隔で poll される（`use-loophub-events.ts:12`）。
   非可視時は停止（`document.visibilityState`）。
2. イベント 1 件は `event-keys.ts` の mapping により 0〜複数の query key を invalidate する。
   invalidation された key に mount 済み query があれば 1 回 refetch される。
3. イベント 1 件あたりの refetch 数は画面構成に依存する。repo top を開いている状態で
   repo スコープのイベントが来ると `pageData/issueList` が主対象（#112 で畳まれており
   行単位の `stateForPull` は消えた）。PR detail なら `pull` 系と
   `workflowRuns/stateForPull`・`workflowRuns/totalCost` が対象。
4. 実際のイベント量はエージェント稼働数に強く依存する。この環境の実測（上記）をレンジの
   基準にする。

### シナリオ（レンジ）

| シナリオ | events/時 | イベント駆動 refetch/時（仮定: 対象 hook 1〜3 本） | 合計 RPC/時/タブ |
| --- | ---: | ---: | ---: |
| アイドル（イベントほぼ無し） | ~0 | ~0 | ~2,460 |
| 低稼働（この環境の平均的 1 日、~118 件/時） | ~118 | ~118〜354 | ~2,580〜2,820 |
| 高稼働（この環境のピーク日 6,400 件/日 ≈ 267 件/時） | ~267 | ~267〜800 | ~2,730〜3,260 |

refetch 1 本のコストはメソッドで大きく異なる。`pageData/issueList` は行ごとの git
fan-out を持つため最も重く（#112 の計測では 1 本 3,582.8ms）、`pulls/usage` や
`workflowRuns/stateForPull` は DB/git 読みで軽い。よって「RPC 本数」だけでなく
「重いメソッドの回数」が実コストの主ドライバになる。

### ペイロードの単位コスト

`events/list` の応答サイズは実測ベースで イベント 1 件 ≈ 151 byte（DB の text 総量/行数）。
`POLL_LIMIT=100` なので、バースト時は 1 ポーリングで最大 ~15 KiB 前後を運ぶ。静止時は
空配列で数 byte 〜十数 byte。

## 前提・データソース・計算方法・除外した要素

- すべてのメソッド名・hook 名・行番号は 2026-08-09 時点の `main`（HEAD `a632cbfc`）の
  worktree から取得。以後の変更で行番号はずれる。
- 「発火する/しない」は静的コード読解による。実際のリクエスト流量・レイテンシは
  `--debug` の debug panel（`web/src/lib/debug-log.ts` の RPC ログ）で確認できるが、
  今回は計測していない（オペレータが別途確認可能な観測点として残す）。
- 実 DB 数値はこの環境の `~/.loophub/loophub.db` に限る。他環境では行数・流量が異なる。
- eager / lazy の設計判断、pageData 畳み込みの追加、dead メソッドの削除判断は行わない
  （#130 のスコープ外）。
- `sessions/costSummary`・`sync/run`・`pulls/createGithubPull` は contract に定義があるが
  SPA から使われない外部向け/運用向け surface として存在する。`diffFeedback/get` も
  contract のみで client.ts に配線がない。

## 人間への質問（本調査では確定できない前提）

以下の前提はデータから確定できないため、判断が必要になった時点で当事者に確認すること。

1. **エージェント稼働数の今後の見込み** — `agent_session.usage_updated` がイベント量の
   66% を占め、`events/list` ポーリングと invalidate refetch の主ドライバである。並行
   稼働エージェント数をどう想定するかで RPC ボリュームは桁が変わる。
2. **dead な 21 メソッドの扱い** — 削除・維持のどちらを選ぶかは設計判断。`workspaces/list`
   `labels/list` 等は pageData に畳まれた後も hook 定義が残っており、削除しても UI は
   動くが、将来の独立取得に再利用する可能性がある。
3. **pageData 畳み込みの対象範囲** — 現状 seed されている 7 メソッド（`issues/get` 等）を
   今後も畳んだままにするか、詳細画面ごとに個別 RPC に戻すかは #112/#123/#125 の規約に
   依存する方針判断。
4. **`events/list` ポーリング間隔** — 1.5s は固定（`VISIBLE_POLL_MS`）。エージェントが
   常時動く運用では 2,400 回/時/タブが下限コストになる。間隔変更の要否は運用負荷次第。
