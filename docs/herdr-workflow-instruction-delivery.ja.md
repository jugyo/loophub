# Herdr workflow instruction delivery

## 結論

未送信の原因は、`pane run` が text と submit 用の `Enter` を1つの terminal input として渡すことだった。coding agent が text を paste として処理すると、同じ入力に含まれる `Enter` も paste の一部になり、prompt が入力済みのまま送信されない。

Herdr v0.7.1 の `pane run` は、text と `Enter` を `PaneSendInputParams` に入れて1回の `pane.send_input` request を送る（[`herdr@dbc45f6:src/cli/pane.rs:949-962`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/cli/pane.rs#L949-L962)、[`herdr@dbc45f6:src/api/schema.rs:142-147`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/api/schema.rs#L142-L147)、[`herdr@dbc45f6:src/api/schema/panes.rs:215-234`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/api/schema/panes.rs#L215-L234)）。handler は同じ request 内で text、keys の順に runtime へ書く（[`herdr@dbc45f6:src/app/api/panes.rs:1400-1428`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/src/app/api/panes.rs#L1400-L1428)）。Herdr 自身の changelog も、final Enter の別送による不安定な実行を `pane run` の atomic request で修正したと記録している（[`herdr@dbc45f6:docs/next/CHANGELOG.md:582-587`](https://github.com/ogulcancelik/herdr/blob/dbc45f6306bda3eee681d73a14b48ffbb39f3fcc/docs/next/CHANGELOG.md#L582-L587)）。

prompt 配送では、literal text を `pane send-text` で入力し、その request が成功してから `pane send-keys Enter` で投稿する。これにより text と submit を別の terminal input にし、user input を shell command として評価しない。

ただし request を分けても paste 処理との衝突は解消しない。2 つの request の書き込みは PTY 上で約 7ms 差で連続し、coding agent の paste 判定窓の内側に収まるため、`Enter` は依然として paste に取り込まれうる。実機観測と、bracketed paste で本文を囲む修正は [Herdr prompt が pane に残り未送信で止まる根本原因](herdr-prompt-unsent-root-cause.ja.md) を参照。

live Execute への継続指示、購読者への ping、cost-limit 通知、Web から PR agent への入力は同じ順序に揃える。Web 入力は pane の再検証後に配送し、non-zero exit を既存の 409 error に変換する。

## 配送と失敗

どの配送先も、宛先の pane 座標を持つ 1 つの行から解決する（continuing 指示は run の Execute target、ping は購読行）。

pane を伴う one-time effect は、配送前に effect receipt を `pending` で確保し、text と `Enter` の両 request が成功した後だけ `completed` にする。receipt schema は `pending` / `completed` のみを許可し、`run_id`・`event_id`・`effect` を主キーにする。どちらかの request の failure は既存の error path に出て、成功として扱わない。ping は receipt を持たない best-effort な配送で、失敗は log に残して落とす。

## 検証

service test は正しい pane への `pane send-text` と `pane send-keys Enter` が順に1回ずつ行われることを確認する。同 test は Herdr の non-zero exit 後に receipt が `pending` のまま残り、自動再送されないことも確認する。

Web 入力の test は日本語、`-` 始まり、shell-like text の各入力がそれぞれ `pane send-text` と `pane send-keys Enter` の組になり、shell command として評価されないことを確認する。
