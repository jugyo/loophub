# Herdr workflow instruction delivery

## 結論

未送信の原因は、文字列入力の `pane send-text` と投稿の `pane send-keys Enter` が別 request であり、前者だけが反映され得る境界を持つことだった（`core/terminal/terminal-launch.ts:438-476`）。

Herdr v0.7.1 の `pane run` は、text と `Enter` を `PaneSendInputParams` に入れて1回の `pane.send_input` request を送る（[`herdr@dbc45f6:src/cli/pane.rs:949-962`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/cli/pane.rs#L949-L962)、[`herdr@dbc45f6:src/api/schema.rs:142-147`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/api/schema.rs#L142-L147)、[`herdr@dbc45f6:src/api/schema/panes.rs:215-234`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/api/schema/panes.rs#L215-L234)）。handler は同じ request 内で text、keys の順に runtime へ書く（[`herdr@dbc45f6:src/app/api/panes.rs:1400-1428`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/app/api/panes.rs#L1400-L1428)）。Herdr 自身の changelog も、final Enter の別送による不安定な実行を `pane run` の atomic request で修正したと記録している（[`herdr@dbc45f6:docs/next/CHANGELOG.md:582-587`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/docs/next/CHANGELOG.md#L582-L587)）。

workflow instruction は、文字列入力と Enter を単一 request で行う `herdrPaneRunArgv` に統一した（`core/terminal/terminal-launch.ts:479-496`）。配送 service はこの helper を一度だけ実行する（`core/service/workflow-instructions.ts:91-100`）。既存の live Execute 注入も同じ `pane run` を使用している（`core/service/workflow-runs.ts:1454-1459`）。

Web から PR agent へ入力する `terminal.sendAgentInput` も、pane の再検証後に同じ helper を一度だけ実行し、non-zero exit を既存の 409 error に変換する（`core/service/terminal.ts:1070-1092`）。

## 配送と失敗

配送先は workflow run に結び付いた唯一の有効な parent pane であり、instruction は `workflow instruction: <JSON>` の1行に変換される（`core/service/workflow-instructions.ts:34-55`）。

配送前に effect receipt を `pending` で確保し、`pane run` 成功後だけ `completed` にして event cursor を進める（`core/service/workflow-instructions.ts:238-268`）。receipt schema は `pending` / `completed` のみを許可し、`run_id`・`event_id`・`effect` を主キーにする（`core/db.ts:854-865`）。配送 failure は worker の既存 error log に出る（`worker/runner.ts:260-275`）。

## 検証

service test は正しい pane への `pane run` が1回だけ行われ、独立した `pane send-keys` が行われないことを確認する（`core/service/workflow-instructions.test.ts:125-176`）。同 test は Herdr の non-zero exit 後に receipt が `pending`、cursor が未更新のまま残り、再配送されないことも確認する（`core/service/workflow-instructions.test.ts:364-396`）。

Web 入力の test は日本語、`-` 始まり、shell-like text の各入力がそれぞれ1回の `pane run` になり、shell command として評価されないことを確認する（`core/herdr-sessions-service.test.ts:863-937`）。
