# Herdr pane 入力注入による稼働中エージェントへの通知 — 調査と POC

> **種別**: 調査記録 + POC 結果（2026-07-04 実施）。実装は未着手（本実装は別 issue で行う）。
> **POC スクリプト**: `scripts/poc-herdr-notify.sh`
> **関連**: `docs/lh-build-design.ja.md`（1 セッション内のサブエージェント編成の設計。本書は
> それとは別レイヤー ── LoopHub が**ホストプロセスを跨いで**エージェントを編成する話）。

---

## 0. 結論（TL;DR）

- **稼働中の Claude Code / Codex の対話 TUI セッションに、外部からメッセージを注入する公式手段は存在しない**（調査時点。§2）。
- 代替として「**Herdr の pane にテキストを入力する**」方式を POC で検証し、**claude / codex 両方で成功**した。アイドル中のエージェントは注入されたテキストを通常のユーザーターンとして処理する（§4）。
- 通知の送信タイミング判定（相手が手待ちか）も herdr の `wait agent-status` で足りる。**Claude Code の Monitor 等ホスト固有機構に依存しない**ため、ホスト非依存の通知路として成立する。

---

## 1. 課題

- Herdr で起動しているエージェントを LoopHub からオーケストレートする方法がない。
- 構想: ある issue についてメインエージェントが実装 → レビューフェーズでは（エージェントに
  よってはチートをするので）LoopHub が**別のレビューエージェント**を起動したい。
- 問題は「レビューが終わった」ことを**メインエージェントに伝える方法がない**こと。
  - Claude Code には Monitor（エージェント自身が内側からポーリングする仕組み）があるが、
    Codex には相当物がなく、共通ソリューションにならない。
- アイデア: LoopHub は Herdr 経由で各エージェントの pane を知っているので、**pane にテキストを
  入力することで「通知」を実現できるのでは**。
- 懸念: 公式の外部入力手段があるならそちらを使うべき → まず調査（§2）。

## 2. 調査: 公式の外部入力手段は無い

公式ドキュメント・リポジトリを調査した結果（2026-07-04 時点の事実）。

### Claude Code

| 手段 | 可否 |
|---|---|
| 稼働中の対話セッションへ外部からメッセージ注入（`claude --session <id> send` 的なもの） | **存在しない** |
| Agent SDK のストリーミング入力 / `ClaudeSDKClient` | 可。ただし**自分が spawn したプロセス限定** ── pane で対話 TUI として動くセッションには使えない |
| `claude -p --resume <id> "msg"` | 同一会話へ新ターンを追加できるが、**元の対話セッションを閉じている必要がある** |
| Monitor ツール | エージェントが**内側からポーリング**する仕組み。外部からの push ではない |
| hooks | セッション内で発生したイベントへの反応のみ。外部イベント → セッションの経路は無い |

出典: [Manage sessions](https://code.claude.com/docs/en/sessions.md) /
[Headless](https://code.claude.com/docs/en/headless.md) /
[Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview.md) /
[Hooks reference](https://code.claude.com/docs/en/hooks.md)

### Codex

| 手段 | 可否 |
|---|---|
| 稼働中 TUI へのメッセージ注入（`codex inject` 等） | **存在しない**。要望 [#11415](https://github.com/openai/codex/issues/11415) は not planned でクローズ。「PTY キー入力エミュレーションしか無いのでローカル ingress が欲しい」という [#15355](https://github.com/openai/codex/issues/15355) は未回答のままオープン |
| app-server（`turn/start` / `turn/steer`）・Codex SDK・MCP server mode | 可。ただし **TUI を捨てて自前でセッションを保持・描画する**前提 |
| `codex exec resume <id> "msg"` | 可（headless）。稼働中の TUI には触れない |
| `notify` 設定 / hooks | **outbound 専用**（`agent-turn-complete` の外部プログラム起動等）。inbound 経路ではない |

出典: [App Server](https://developers.openai.com/codex/app-server) /
[SDK](https://developers.openai.com/codex/sdk) /
[Non-interactive](https://developers.openai.com/codex/noninteractive) /
[Hooks](https://developers.openai.com/codex/hooks) /
[config-advanced (notify)](https://developers.openai.com/codex/config-advanced)

### 含意

- 「pane にキー入力を送る」方式は、Codex 公式も（#15355 で）現状唯一の現実解と認識しているもの。
  **公式手段が無い以上、pane 注入は妥当な選択**。
- ただし両ホストとも headless モード（Claude Agent SDK / `codex exec resume`・app-server）なら
  公式にメッセージを逐次供給できる。「TUI で人が覗ける」ことを要件から外せるなら、公式ルートが
  将来の選択肢になる。

## 3. 前提の確認: herdr socket API は外部プロセスから叩ける

- `herdr --session <name> pane run|send-text|send-keys|read|list` と `wait output|agent-status` は
  **herdr の外のプロセスから**動く（`HERDR_ENV` 不要。socket 経由）。
- LoopHub は既に `herdr --session <name> ...` 形式の argv ビルダー（`core/terminal-launch.ts`）で
  pane を操作しており（例: pane close）、`herdr session list` / `agent list` で **pane_id も把握済み**
  （`core/herdr-status.ts`）。`pane send-text` は同じパターンにそのまま乗る。
- 通知タイミングの判定は `herdr wait agent-status <pane> --status idle`（または `done`）で
  「相手が手待ちになった」を検知できる。claude / codex どちらでも同じに動く（herdr が状態検出を持つ）。

## 4. POC: 方法と結果

`scripts/poc-herdr-notify.sh`（`poc-herdr-notify.sh [claude|codex] [session-name]`）。
検証環境: herdr + claude v2.1.201 + codex-cli 0.142.5、テスト用セッション `test-202607`。

シナリオ（LoopHub の役をスクリプトが演じる）:

1. 新規タブに pane を作り、エージェント（claude / codex）を起動
2. 「タスクを終えたら外部からの `[loophub-notify]` メッセージを待て」というタスクを投入
3. エージェントがアイドルになる（= レビュー待ちの dev エージェントを再現）
4. **外部プロセスから `herdr pane run <pane> "[loophub-notify] review completed for PR #123: ..."` を注入**
5. エージェントが起きて処理したことを `wait output` で検証

**結果: claude / codex とも成功。** 注入テキストは通常のユーザーターンとして処理され、
エージェントは内容（PR 番号・承認・nits）を理解した応答を返した。

### ハマりどころ（スクリプトに対策済み）

1. **claude の trust ダイアログ**: ホームディレクトリで起動すると毎回「trust this folder?」が出て、
   注入テキストを吸ってしまう。画面を読んで検出し Enter で応答してから本題を送る。
   （リポジトリ / worktree での起動なら初回のみのはず。）
2. **idle 直後の取りこぼし**: `agent_status` が idle になった直後は TUI の入力欄が未マウントの
   ことがあり、最初の send-text が落ちる。idle 検知後 2 秒待ってから送る。
3. **`wait output` の echo 誤マッチ**: 照合トークンを指示文に含めると、注入した入力の echo に
   マッチしてしまう（検証専用の罠）。トークンは分割して指示する。

## 5. 本実装に向けた論点（未検証事項）

- **working 中に送るとどうなるか**: POC はアイドル時のみ検証した。両 TUI とも入力はキューされる
  はずだが未確認。送信前に `agent_status` が idle/done になるのを待つ設計が安全。
- **人間との入力衝突**: 人間が同じ pane に入力中だと注入と混ざる（codex #15355 でも指摘されている
  既知の弱点）。
- **untrusted データの扱い**: 注入メッセージにレビュー結果など issue 由来テキストを埋める場合、
  `lh-build-design.ja.md` §10 の untrusted 原則（nonce フェンス）がそのまま適用されるべき。
  受け手にとって注入メッセージは「ユーザー入力」として届くため、埋め込むデータの選別は送信側
  （LoopHub）の責務になる。
- **LoopHub 側の形**: `lh notify <pane>` のような単発 CLI にするか、オーケストレーション機構の
  一部にするか。pane_id の解決・idle 待ち・送信をまとめた core プロシージャに置くのが既存の
  責務分割（cli は薄く）に沿う。
