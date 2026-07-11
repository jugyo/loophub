<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loophub-logo-dark.svg">
    <img src="docs/assets/loophub-logo.svg" alt="LoopHub" height="40">
  </picture>
</h1>

ローカルの git リポジトリに対する GitHub 風の issue / PR ハブ。AI エージェントが動かす
開発ループを、人間が「監督者」として最小の注意で見るための UI/CLI。

## ランタイム要件

- **Node.js >= 22.12.0**
- データ層は **`node:sqlite`**（`DatabaseSync`）を使用。Node 22.x では experimental の
  ため起動時に `--experimental-sqlite` フラグが必要。本リポジトリの npm scripts と
  ランチャは `NODE_OPTIONS='--experimental-sqlite --disable-warning=ExperimentalWarning'`
  でこれを付与する（Node 24+ ではフラグ不要）。
- TypeScript はビルドせず [`tsx`](https://github.com/privatenumber/tsx) で直接実行。

## レイアウト

```
core/        純ドメインライブラリ（Node）: db / config / store / git / events / links / watcher
             service（手続き層）/ serialize（JSON 整形）/ errors
cli/         lh コマンド（core/service を直 import、HTTP 非経由）
web/server/  lh-web: node:http サーバ（POST /rpc）+ JSON-RPC dispatcher
             + JSON Schema 契約（core/service を公開）+ SPA 配信
web/         SPA（Vite + React + TanStack）: JSON-RPC と events/list polling
worker/      lh-worker: events を tail し `.loophub/workflow.yml` の run をイベント駆動で実行
```

## JSON-RPC 契約

`web/server/` が core/service を **JSON-RPC 2.0**（単一エンドポイント `/rpc` 想定、`namespace/method`
命名）で公開する。受信 params はメソッド毎の **JSON Schema**（ajv）で実行時検証し、`initialize` で
capability negotiation を提供する。Web UI は `events/list` を id cursor で polling する。契約は
言語中立で、クライアントは core 型を import しない。HTTP プロセス化（lh-web）は S3。

言語中立な契約ドキュメント: [`docs/rpc-contract.json`](./docs/rpc-contract.json)（`npm run contract` で再生成）。
公開 interface の削除・移行案内: [`docs/breaking-changes.ja.md`](./docs/breaking-changes.ja.md)。

### JSON-RPC transport limits

`POST /rpc` は request body を 1 MiB、batch を 100 要素、serialized response を 10 MiB に制限する。
request body 超過は HTTP 413 / JSON-RPC `-32002`、batch 超過は HTTP 200 / `-32600 Invalid Request`、
response 超過は HTTP 200 / `-32001 Response too large` を返す。通常の SPA request は上限内であり、
`lh` CLI は JSON-RPC を経由せず `core/service` を直接呼ぶため対象外である。詳細は
[Web server documentation](./web/README.md#json-rpc-transport-limits) を参照。

## lh-web（Web サーバ）

`lh-web` は web 自身の Node プロセス。常駐 daemon（旧 `lh serve` / `Bun.serve`）はなく、見ている間だけ動く。

```sh
npm install                     # web の依存も postinstall で入る
npm run lh-web                  # http://localhost:8730 — API + UI + HMR を 1 プロセスで提供
```

`lh-web` は Vite を middleware mode で内蔵し、`/rpc` と `/attachments` route 以外を Vite に委譲する。
単一コマンド・単一ポートで API も SPA も HMR も提供する（別プロセスの dev server は不要）。
`--port <n>` でポートを変更できる。
既定では loopback（`127.0.0.1`）にのみ bind する（内蔵 Vite が web/ のソースを配信するため）。
LAN から開きたいときだけ `LOOPHUB_HOST=0.0.0.0` を指定する。

> フロントだけを触りたいときは `cd web && npm run dev`（:5173）で Vite を単体起動も可能。
> その場合は `/rpc` と `/attachments` route を別起動の lh-web（:8730）へ proxy する。

## lh-worker（イベント駆動ランナー・v1）

`lh-worker` は events テーブルを id cursor で tail する常駐プロセス。リポジトリルートの
`.loophub/workflow.yml`（VCS 管理・可搬）を読み、`issue.opened` / `pull_request.opened` で
`run` のシェルコマンドを cwd = 対象リポジトリの `local_path` で実行する。

```yaml
# .loophub/workflow.yml
on:
  issue.opened:
    - run: ./scripts/triage.sh
    - run: lh build "$LH_ISSUE_NUMBER" --herdr
  pull_request.opened:
    - run: npm test
```

```sh
npm run lh-worker               # events を tail（--poll-ms <ms> で間隔指定）
```

- run には `LH_EVENT_TYPE` / `LH_REPO` / `LH_ACTOR` / `LH_EVENT_PAYLOAD` と、issue/PR 系の
  `LH_ISSUE_NUMBER` / `LH_PR_NUMBER`、PR 系の `LH_WORKTREE_PATH`（`git worktree list` を head_ref で
  マッチさせたパス。無ければ空）を渡す。
- 実行ごとに `workflow.run_started` / `workflow.run_completed` を events に emit（Web タイムラインに表示）、
  stdout/stderr 全文を `~/.loophub/logs/<owner>/<repo>/<event>-<id>.log` に保存する。
- cursor は DB ではなく `~/.loophub/worker-cursor.json` に atomic 保存。初回は `MAX(events.id)` から
  =「今から」処理し、再起動は永続値から継続する。あるコマンドが失敗しても後続 run / 後続イベントは止めない。

> **run は即終了する前提**。worker は run を直列・同期実行し、完了するまで次のイベントを処理しない。
> 重い処理(`lh build` 等)は run 内で外部アプリへ起動を依頼して即 return する設計。長時間ブロックする run は
> 後続イベントを止めるため、自前でバックグラウンド化(`... &` / nohup)するか即終了させること。
>
> **run は worker の環境変数をそのまま継承する**。`workflow.yml` はリポジトリの VCS に入った任意シェルを
> 実行するため、自分のシェルと同程度に信頼できるリポジトリでのみ使うこと(worker 起動時の env にある
> token 等が run から読める)。`LH_ACTOR` / `LH_EVENT_PAYLOAD` など event 由来の値は信頼できない入力なので、
> run 内では必ずクォート(`"$LH_ACTOR"`)し `eval` しないこと。

## CLI（`lh`）

ビルド不要。ラッパーを一度入れると `lh` が PATH に入る:

```sh
./scripts/install-lh-wrapper.sh   # ~/.local/bin/lh を作成（node + tsx 起動）
lh repo add . --name me/proj
lh issue create --title "do the thing" --label ready-to-build
lh pr create --head feature-x --base main --title "impl" --issue 5
```

別 checkout を指す場合は `LOOPHUB_ROOT=/path/to/loophub lh ...`。CLI は `core/service` を直接呼び、
サーバープロセスは不要（同じ `LOOPHUB_HOME` の SQLite に直接読み書きする）。

## 開発

```sh
npm install
npm test          # vitest（core テスト）
npm run test:watch
npm run typecheck # tsc --noEmit（型チェック）
npm run lint      # biome check（lint + フォーマット検査・書き込みなし）
npm run format    # biome format --write（フォーマット適用）
```

lint / format は [Biome](https://biomejs.dev) を使用（設定は `biome.json`）。

## 進捗（rearchitect S1–S7）

- [x] **S1** core を Node 化（`node:sqlite` / `node:fs` / `node:child_process` / vitest）
- [x] **S2** MCP 流 JSON-RPC 2.0 + JSON Schema 契約（`web/server/`）
- [x] **S3** `lh-web` 新設（node:http で `/rpc` + SPA 配信）・`lh serve` 廃止
- [x] **S4** web クライアントを契約準拠 JSON-RPC と `events/list` polling へ移行
- [x] **S5** `lh`(cli) を Node + core 直叩き（HTTP 廃止、service/serialize 層を新設）
- [x] **S6** v1 UI 削除（本リライトでは `ui.html`/`ui.ts` を最初から持ち込まず、lh-web は v2 のみ配信）
- [ ] **S7** 再レイヤリング + docs/scripts/skills 整理
