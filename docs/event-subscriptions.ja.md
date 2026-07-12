# イベント購読(汎用 pub/sub + herdr notify)

worker からドメイン配線を抜くための汎用機構(#1232)。worker の責務は「イベント X が起きたら、
購読している herdr pane に notify を注入する」まで。そのイベントに反応して何をするか(rebase を
回す等)は購読側エージェントの配線であり、worker は skill 名もドメインの事情も知らない。

## 責務分離

- **worker(イベント源)**: 検知ロジックは worker に残る。例: conflict sweep
  (`core/pull-conflict-events.ts`)は open PR の clean → conflict 遷移を検知して
  `pull_request.merge_conflict` を 1 回だけ emit する(clean はレビュー通過済み・マージ可能な
  状態を指す — レビュー前の PR が conflict 化しても発火しない)。状態は毎 tick 記録
  (`pull_conflict_states`)されるため、conflict のまま留まる間は再発火しない
  (間隔は既定 15s。`--conflict-sweep-ms` / `LOOPHUB_CONFLICT_SWEEP_MS`、0 で off)。
- **worker(配送)**: event tail(`worker/runner.ts`)が全イベントを
  `subscriptions.notifyForEvent` に渡す。購読が一致すれば
  `herdr --session <s> pane run <pane_id> <text>` で 1 行のテキストを注入する。idle の
  claude/codex pane は注入テキストを通常のユーザーターンとして処理する。注入される行の形式
  (`core/event-subscriptions.ts` の `buildNotifyText`。`number=` はイベント payload に number が
  ある場合のみ):

  ```text
  LoopHub event: type=pull_request.merge_conflict repo=owner/name number=123 event_id=456. You subscribed to this event via `lh subscribe`; handle it according to your own instructions.
  ```
- **購読側(ドメイン配線)**: エージェントが `lh subscribe --event <type>` で自分の pane を登録
  し、notify を受けたら自分の指示(skill / プロンプト)に従って行動する。例: 解消エージェントが
  `pull_request.merge_conflict` を購読し、notify 起点に `/lh-rebase-conflict <pr>` を回す。

## 購読の登録と識別

herdr は全 pane に `HERDR_SESSION` / `HERDR_PANE_ID` を注入している。`lh subscribe` はこれを
読んで pane を自己登録する(`LOOPHUB_SESSION_ID` があれば attribution として記録)。購読は
(repo, event type, pane) 単位で、イベント種別は完全一致のみ(ワイルドカードなし)。repo は
`--repo owner/name` か、repo ルートで実行したときの cwd から解決される(worktree 内では
`--repo` 必須)。存在するイベント種別は `lh events` の出力(type 列)で確認できる — 存在しない
type でも登録自体は成功するが、notify は永久に発火しない(例外: `event_subscription.*` は登録時に
拒否される — 後述の自己ループ参照)。

```sh
lh subscribe --repo owner/name --event pull_request.merge_conflict   # この pane を登録(冪等)
lh subscribe list [--repo owner/name] [--json]                       # 購読の確認
lh unsubscribe --event pull_request.merge_conflict                   # この pane の解除(全 repo)
lh unsubscribe --all --repo owner/name                               # repo を絞った全解除
```

## guard とライフサイクル

- **重複購読**: UNIQUE(repo_id, event_type, herdr_session, herdr_pane_id)。`lh subscribe` の
  再実行は冪等。
- **多重 notify**: worker の event tail はカーソルで各イベントを 1 回だけ処理し、購読ごとに
  1 回だけ注入する。イベント自体の重複(conflict 継続中の再発火)はイベント源側の遷移記録で防ぐ。
- **自己ループ**: notify 成功ごとに監査イベント `event_subscription.notified` を emit するが、
  `event_subscription.*` 名前空間は登録時に明示拒否され(`lh subscribe` が not deliverable
  エラー)、仮に行が存在しても配送側で除外される(defense in depth)。
- **掃除(lazy cleanup)**: 常駐の生存監視は持たない。pane が消えた購読は次の notify が失敗した
  時点で削除され、worker ログに可視化される。retry はしない(イベント行は events テーブルに
  残っており、人間がリカバリできる)。自発的な解除は `lh unsubscribe`(pane 単位、`--repo` で
  絞り込み可)。repo 削除時は購読も削除。
- **pane 所有権**: 所有権チェックはしない(`--herdr-session` / `--herdr-pane-id` で他 pane も
  登録できる)。LoopHub はローカル単一ユーザー前提であり、同一ユーザーの deliberate な操作は
  信頼する — accidental な誤爆だけを pane 単位スコープで防ぐ。

## 既存機構との関係

`.loophub/workflow.yml` の SUPPORTED_EVENTS(イベント → シェルコマンド)と `lh-watch`
(ポーリング型の常駐 watcher)は別機構のまま。将来これらを本機構へ寄せるかは別 issue で判断する。
