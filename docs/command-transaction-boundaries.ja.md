# Command transaction 境界

DB を変更する service procedure は、一つの command が行う state 変更と、その変更を告げる event
記録を、同じ commit / rollback 単位に置く。片方だけが残ると state と event trail が食い違い、
そのずれは多くの場合あとから復旧できない。

> **一言で言うと:** 「何が起きたか」を記録した row と、「起きたことを知らせる」event row は、
> 必ず一緒に commit されるか、一緒に消える。git・spawn・HTTP・filesystem は、その境界の外で行う。

---

## 何を守るための境界か

sweep 系がいちばん分かりやすい。`sweepPullUpdates` は open PR の head SHA を観測して
`pull_request.updated` を発火するが、SHA の記録だけが commit されて event を失うと、次の tick は
「記録済みの SHA と同じ」と判断して何も発火しない。その更新は二度と通知されない。

同じ形が、遷移や flag を消費してから event を出す経路すべてにある。

| 経路 | 消費されるもの | event を失うと |
|---|---|---|
| `sweepPullUpdates` | 記録済み head SHA | 次 tick が「変化なし」と判断し、更新が二度と出ない |
| `sweepPullConflicts` | `clean -> conflict` の edge | 以後 `conflict -> conflict` になり、衝突が報告されない |
| `syncGithubMergeStatus` | link の「未 merge」flag | link が sweep 対象から外れ、prompt が出ない |
| `sweepMergeReadyNotifications` | 観測済み mergeable state | その clean 遷移の通知が失われる |
| `snapshotHerdrSessionsImpl` | snapshot signature | 次に signature が変わるまで client が stale のまま |
| notification の signal backfill | source cursor | cursor の先にある signal が読み飛ばされる |
| `sessions.usageSync` | transcript cursor | 実際には読んでいない位置から次回再開する |

state と event を同じ transaction に入れることが、この「消費したのに知らせていない」状態を作らせない。

## owner の決め方

用語を二つ先に定める。

- **同期 DB 区間** — 一つの procedure の中で、外部 I/O を挟まずに連続する DB 操作のまとまり。
  procedure が git や HTTP を呼ぶと、そこで区間が切れる。
- **owner** — その区間に対して `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` を出す関数。
  「誰が transaction を開けて閉じるか」であって、「誰が transaction の中で動くか」ではない。

前提として、**SQLite の単一 statement は autocommit で既に atomic** である。だから write が
一つしかない区間に transaction を足しても、守られる不変条件は何も増えない。境界が意味を持つのは
**一緒に成立しなければ困る write が 2 つ以上ある**ときだけである。

したがって判断の原則は一つに書ける。

> **同期 DB 区間の全体が、既に atomic か。atomic でなければ、その procedure が owner になる。**

実際に現れる形は次の 4 つで、前半 2 つが「helper が owner」、後半 2 つが「procedure が owner」になる。

| 同期 DB 区間の形 | 既に atomic か | owner | 例 |
|---|---|---|---|
| 単一 statement の store helper 一つ | ○（autocommit） | helper | `events.emit` → `emitEvent` |
| 自前で `db.transaction` を持つ helper 一つ | ○ | helper | `terminal.cleanupClosedIssuePanes` → `releaseHerdrPaneClaimsForResource` |
| helper が 2 つ以上（state write と event など） | ✗ | **procedure** | `comments.create`（comment + `issue.commented`） |
| helper は一つだが、その中身が transaction を持たない複数 statement | ✗ | **procedure** | `repos.remove` → `deleteRepo`、`terminal.launch` → `upsertIssueHerdrPane` |

最後の行が、規則が「呼び出し回数を数えること」ではないことを示している。見るのは回数ではなく、
**区間全体が一つの単位として確定するか**である。

### なぜ helper に owner を残す形が成立するのか

primitive は `core/db.ts` の `Db.transaction` 一つだけで、これは **nested join** する。最も外側の
呼び出しだけが `BEGIN IMMEDIATE` / `COMMIT` / `ROLLBACK` を持ち、内側の呼び出しは既に開いている
transaction に参加するだけで、自分では commit しない。

これがないと、`db.transaction` を内包する helper（`createIssue` など）を procedure 側から囲んだ
瞬間に、内側の `BEGIN` が "cannot start a transaction within a transaction" で失敗する。
join があるおかげで、**既存の store helper を一切書き換えずに、外側から境界を足せる**。
helper を単体で呼ぶ既存の caller や test は、従来どおり atomic なまま影響を受けない。

```ts
// issues.create の同期 DB 区間。個々の helper は atomic だが、区間全体はそうではない。
db.transaction(() => {          // ← ここだけが BEGIN IMMEDIATE を出す
  S.createIssue(...);           //   内部の db.transaction は join するだけ
  S.setLabels(...);
  S.addAcceptanceCriterion(...);
  S.emitEvent(r.id, "issue.opened", ...);
});                             // ← ここだけが COMMIT を出す
```

### なぜ「念のため全部包む」をしないのか

区間が既に atomic なところに wrapper を足しても、`BEGIN` と `COMMIT` が増えるだけで不変条件は
変わらない。増えるのは読む側の負荷である。wrapper が至るところにあると、**そこに守るべき組が
あるのかどうかが読み取れなくなる**。

`db.transaction` が書いてあることが「ここには一緒でなければ困る write が複数ある」という
signal であってほしい。だから、意味を持たない箇所には足さない。

## 外部 I/O は callback の外

transaction callback の中で git・spawn・HTTP・filesystem を行ってはならない。writer lock を外部
プロセスの待ち時間だけ保持することになる。

callback は同期でなければならない。`Db.transaction` の `SyncCallback` 型が `async` callback と
Promise を返す callback を compile time に拒否するため、非同期な外部 I/O は型で塞がれている。
残るのは同期の I/O — `spawnSync` 経由の git 呼び出しと `node:fs` の同期 read — なので、
callback を足すときはそこだけ目視で確認する。

serializer は見た目で判断せず、実装で選別する。

- **callback の中に置ける**: `issueJSON` / `repoJSON` / `commentJSON` など、row を wire 形に写すだけのもの
- **callback の外に出す**: `pullJSON` / `issueDetailJSON`（git を読む、`core/serialize-status.ts`）、
  `repoAgentConfigJSON`（application default を `config.json` から読む）

write の間に外部 I/O が挟まっている場合は、read を DB 区間の前へ移す。

- diff feedback の location precompute — anchor を全件 git に対して解決してから、cache の書き込みだけを
  一つの区間で行う
- `sessions.usageSync` — runtime module が transcript の走査と読み出しと相関を済ませて sync plan を組み、
  その後 executor が cohort ごとの write を一区間にする。cohort は同じ transcript 群を取り合う session の
  集まり（Cursor の同一 cwd）で、取り合いのない runtime では session 単位になる
- `workflowRuns.start` — run row と `workflow_run.started` を一区間にし、parent contract file の
  書き出しはその後に置く

## 一つに束ねない protocol

claim → 外部 effect → complete の receipt protocol は、意図的に別々の commit 点を持つ。claim が
durable になってからでなければ外部 effect を起こせないので、三段を一つの transaction にすると
claim の意味が失われる。

- `workflowEscalation.escalateHuman`
- `workflowCostHold.run`
- `workflowInstructions.dispatchRun`（pane への配送を挟む）
- `scheduledTasks` の発火（herdr launch を挟む）
- pane cleanup（`terminal.cleanupClosedIssuePanes` と `closeManagedHerdrPaneIfUnclaimed`）— claim を
  解放してから herdr の pane を閉じ、閉じ終えてから `markHerdrPaneClosed` を書く。閉じる前に
  closed と記録すると、実際には生きている pane を誰も掃除しなくなる

`settings.update` も同様に分ける。SQLite の instance setting と `config.json` は別の failure domain
なので、一つの transaction で両方を守れるように見せない。

## 失敗の扱い

transaction 内の error は最外まで伝播させ、最外が rollback する。callback の中で catch して続行しては
ならない。それは command の半分を commit することになる。savepoint、rollback-only flag、部分成功、
自動 retry はいずれも導入しない。失敗は既存の 非 0 exit → RPC error → UI の経路で可視化し、
どう対処するかは人間が決める。

`core/migrations.ts` はこの境界の対象外である。schema migration と台帳行を独自の transaction で
管理している。

---

## Inventory

DB を変更する service procedure と、その transaction owner。`store helper` は、その procedure の
同期 DB 区間が単体で atomic な store helper 呼び出しだけであることを意味する。

### Issue / PR / review / comment

| procedure | owner | 同一 transaction の DB write | transaction 外 |
|---|---|---|---|
| `issues.create` | procedure | issue、labels、acceptance criteria、pane link、`issue.opened` | branch 検証の git read |
| `issues.import` | procedure | issue、GitHub issue link、`issue.opened` | GitHub fetch |
| `issues.update` | procedure | issue fields、labels と `issue.labeled`、state event、linked PR の close cascade | branch 検証の git read |
| `issues.addLabels` | procedure | labels、`issue.labeled` | — |
| `issues.acAdd` / `acSetEnabled` / `acReorder` | procedure | criterion write、issue touch | — |
| `pulls.create` | procedure（外部 I/O 後の区間） | pull-shaped issue row、pull row、`pull_request.opened` | number-derived head 用の issue number 予約、head / base の SHA read |
| `pulls.update` | procedure | issue fields、`pull_request.updated` | 応答の `pullJSON` |
| `pulls.delete` | procedure | PR 関連 row の削除、`pull_request.deleted` | git ref / worktree は削除しない |
| `pulls.recordGithubPull` | procedure | GitHub PR link、`pull_request.github_pr_recorded` | URL validation のみ |
| `pulls.unlinkGithubPull` | procedure | GitHub PR link と status cache の削除、`pull_request.github_pr_unlinked` | link 有無の guard read |
| `pulls.createGithubPull` / `pushGithubPull` | procedure | GitHub PR link / pushed SHA、対応する event | git push、`gh`、pushed SHA の read |
| `pulls.merge` | procedure | merge state、linked issue close、`pull_request.merged` と `issue.closed` | merge の git operation |
| `pulls.githubStatus` | store helper | status cache | GitHub fetch |
| `dev.openPr` | procedure（既存 PR を再利用する path） | 再利用した PR の session link、`pull_request.updated` | base branch の git 検証。新規作成 path は `pulls.create` の行に従う |
| `dev.attachSession` | procedure | PR の session link、`pull_request.updated` | — |
| `comments.create` | procedure | comment、`issue.commented` | — |
| `comments.createForPull` / `createHumanForPull` | procedure | comment、`pull_request.commented` | — |
| `comments.reactForPull` / `reactHumanForPull` | procedure | reaction の read-modify-write、`pull_request.comment_reaction_changed`、応答の read | — |
| `comments.setArchivedForPull` | store helper | archived state | — |
| `reviews.create` | procedure | review、AC grades、line comments、`pull_request.review_submitted` | head SHA の git read |
| `diffFeedback.create` | procedure | thread、first message、`pull_request.diff_feedback_created` | anchor 解決の git diff read |
| `diffFeedback.reply` | procedure | reply、`pull_request.diff_feedback_replied` | — |
| `diffFeedback.react` | procedure | reaction の read-modify-write と応答の read | — |
| `diffFeedback.archive` | store helper | archived state | 応答の git read |
| `diffFeedback.precompute` | procedure | location cache の upsert 全件 | 全 anchor の git 解決 |
| `closeOpenPullsForIssue` | procedure（caller の transaction に join） | 各 linked PR state、system comment、`pull_request.closed` | — |
| `handoffs.record` | procedure | handoff、`handoff.recorded` | — |
| `retros.create` | procedure | retro、`session.retro.created` | — |

### Repo / workspace / workflow / settings

| procedure | owner | 同一 transaction の DB write | transaction 外 |
|---|---|---|---|
| `repos.create` | procedure | repo、`repo.created` | path / default branch の検証 |
| `repos.setArchived` / `setFavorite` / `setMergeMode` | procedure | setting、対応する `repo.*`、応答の read | — |
| `repos.setAgentConfig` | procedure | setting、`repo.agent_config_changed` | 応答の `repoAgentConfigJSON`（`config.json` を読む） |
| `repos.setGithubPrExportExtraPrompt` | procedure | setting、`repo.github_pr_export_extra_prompt_changed`、応答の read | — |
| `repos.rename` | procedure | identity row、`repo.renamed` | worktree 一覧、dev lock の scan |
| `repos.update` | store helper | repo fields、open PR の head SHA | path / branch 検証、SHA read |
| `repos.remove` | procedure | repo と cascade 対象 row | filesystem は削除しない |
| `workspaces.create` | procedure | workspace、`workspace.created` | branch 作成 |
| `workspaces.archive` / `unarchive` | procedure | archived state、対応する `workspace.*`、応答の read | branch 存在確認 |
| `workflows.create` / `update` / `delete` | procedure | workflow row、対応する `workflow.*` | — |
| `settings.update` | procedure | SQLite の instance setting、`settings.updated` | `config.json` の write |
| `events.emit` | store helper | event row | — |

### Workflow run

| procedure | owner | 同一 transaction の DB write | transaction 外 |
|---|---|---|---|
| `workflowRuns.start` | procedure | run row、`workflow_run.started` | PR / worktree provision、dev lock、contract file write。parent session 登録は provision 前の独立区間 |
| `workflowRuns.advanceToVerify` / `awaitHuman` / `resumeAfterHuman` / `activateStep` / `requestRework` | procedure（`updateRunLifecycle`） | run lifecycle fields、`workflow_run.updated` | pane 操作、git SHA read |
| `workflowRuns.increaseCostLimit` / `increaseCostLimitForHuman` | procedure | limit update、`workflow_run.cost_limit_increased` | — |
| `workflowRuns.confirmStepLaunch` | procedure | child session、session link、step / active state、handoff、`handoff.recorded`、`workflow_step.launched` | agent は既に spawn 済み |
| `workflowRuns.detectCostExceeded` | store helper | 条件付き `workflow_run.cost_exceeded` | — |
| `workflowRuns.launchStep` | store helper | child sequence の予約 | worktree / git read、launch plan 作成 |
| `workflowRuns.turnDone` / `escalate` | store helper | 対応する event | step result / git SHA read |
| `workflowRuns.next` | store helper | run cursor advance | watch wait |
| `workflowRuns.deliver` | 委譲（`activateStep`） | — | herdr agent list と pane run |
| `workflowInstructions.registerParentPane` | procedure | pane row、resource link | — |
| `workflowInstructions.dispatchRun` | procedure（区間ごと） | receipt claim / complete と cursor advance | pane への配送。claim と complete は配送を挟んだ別区間 |
| `workflowEscalation.escalateHuman` | 三段 protocol | escalation event、claim、issue comment と `issue.commented`、complete | — |
| `workflowCostHold.run` | 三段 protocol | claim、await-human の state と event、complete | herdr list / Escape / pane notification |
| `workflowWatch.beginEffect` / `completeEffect` | store helper | receipt の claim / complete | wait、source event の選択 |

### Session / notification / worker sweep

| procedure | owner | 同一 transaction の DB write | transaction 外 |
|---|---|---|---|
| `sessions.register` | procedure | session row、`agent_session.registered` / `updated` | — |
| `sessions.link` | procedure | session link、`agent_session.linked` | — |
| `sessions.usageSync` | executor（cohort ごと） | usage rows、subagent usage、message dedupe、cursor、external session と `agent_session.updated` | transcript の走査と読み出し、相関、cost 計算 |
| `notifications.send` | procedure | notification、`notification.created` | — |
| `notifications.read` / `readAll` | procedure | read state、`notification.updated` | 先行する generated notification の refresh |
| notification の signal backfill | procedure | generated notification、`notification.created`、source cursor | — |
| `scheduledTasks.create` / `update` / `delete` | procedure | task row、対応する `scheduled_task.*` | — |
| `scheduledTasks.run` / `sweep` | 二段 protocol | run claim、finish result | herdr launch |
| `terminal.launch` | procedure | pane row と claim、`pull_request.github_pr_export_started`（launch 成功後） | herdr spawn、workspace / tab / pane 操作 |
| `terminal.cleanupClosedIssuePanes` | store helper（`releaseHerdrPaneClaimsForResource`）+ pane ごとの二段 protocol | claim の解放と close 候補の確定 | pane ごとの herdr close。close 後の `markHerdrPaneClosed` は次の DB 区間 |
| `terminal.cleanupClosedPullDevAgents` | store helper | `agent_session.killed` | herdr の session / agent list と workspace close |
| `closeManagedHerdrPaneIfUnclaimed` | store helper | `markHerdrPaneClosed` | foreground process の kill と herdr pane close |
| `sweepPullUpdates` | procedure（PR ごと） | head SHA、issue touch、`pull_request.updated` | ref の解決 |
| `sweepPullConflicts` | procedure（PR ごと） | 観測した conflict state、`pull_request.merge_conflict` | mergeable state の git read |
| `sweepMergeReadyNotifications` | procedure（PR ごと） | 観測した state、notification、`notification.created` | mergeable state の git / GitHub read |
| `syncGithubMergeStatus` | procedure（link ごと） | `github_merged` flag、`pull_request.github_merged` | GitHub fetch |
| `terminal.snapshotHerdrSessions`（`snapshotHerdrSessionsImpl`） | procedure | snapshot row、`terminal.sessions_updated` | herdr snapshot の capture |
| `githubFeedbackSync` | procedure | 取得した feedback observation、source event | GitHub fetch |

DB を変更しない `pulls.files` / `diff` / `commitFiles` / `fileAtRef`、`worktrees.*`、`resume.*`、
`herdr.*`、`terminal.agentRead` などはこの一覧の対象外である。

## テスト

`core/service/transaction-boundaries.test.ts` が、SQLite の `BEFORE INSERT ... RAISE(ABORT)` trigger で
event の書き込みを一件だけ失敗させ、command が何も残さないことを確認する。store helper を mock せず
実際のコードパスをそのまま通すため、観測されるのは command 自身の rollback の結果である。

新しい command を足すときは、この形の failure injection を一本足す。落とすべきは
「state だけ残って event が無い」ではなく、「その state を残したせいで、二度と event が出なくなる」
経路である。
