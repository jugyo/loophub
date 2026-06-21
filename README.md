# LoopHub

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
core/        純ドメインライブラリ（Node）: db / config / store / git / event-hub / links / watcher
             service（手続き層）/ serialize（JSON 整形）/ errors
cli/         lh コマンド（core/service を直 import、HTTP 非経由）
web/server/  lh-web: node:http サーバ（POST /rpc, GET /events SSE）+ JSON-RPC dispatcher
             + JSON Schema 契約 + events notification（core/service を公開）+ SPA 配信
web/         SPA（Vite + React + TanStack）: api クライアントは契約準拠 JSON-RPC
```

## JSON-RPC 契約

`web/server/` が core/service を **JSON-RPC 2.0**（単一エンドポイント `/rpc` 想定、`namespace/method`
命名）で公開する。受信 params はメソッド毎の **JSON Schema**（ajv）で実行時検証し、`initialize` で
capability negotiation、events は `events/notify` notification（SSE 相当）で配信する。契約は言語中立で、
クライアントは core 型を import しない。HTTP プロセス化（lh-web）は S3。

言語中立な契約ドキュメント: [`docs/rpc-contract.json`](./docs/rpc-contract.json)（`npm run contract` で再生成）。

## lh-web（Web サーバ）

`lh-web` は web 自身の Node プロセス。常駐 daemon（旧 `lh serve` / `Bun.serve`）はなく、見ている間だけ動く。

```sh
npm install                     # web の依存も postinstall で入る
npm run lh-web                  # http://localhost:8730 — API + UI + HMR を 1 プロセスで提供
```

`lh-web` は Vite を middleware mode で内蔵し、`/rpc`・`/events` 以外を Vite に委譲する。
単一コマンド・単一ポートで API も SPA も HMR も提供する（別プロセスの dev server は不要）。
`--port <n>` でポート変更、`--poll-ms <ms>` でイベントポーリング間隔を指定できる。
既定では loopback（`127.0.0.1`）にのみ bind する（内蔵 Vite が web/ のソースを配信するため）。
LAN から開きたいときだけ `LOOPHUB_HOST=0.0.0.0` を指定する。

> フロントだけを触りたいときは `cd web && npm run dev`（:5173）で Vite を単体起動も可能。
> その場合は `/rpc`・`/events` を別起動の lh-web（:8730）へ proxy する。

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
```

## 進捗（rearchitect S1–S7）

- [x] **S1** core を Node 化（`node:sqlite` / `node:fs` / `node:child_process` / vitest）
- [x] **S2** MCP 流 JSON-RPC 2.0 + JSON Schema 契約 + events notification（`web/server/`）
- [x] **S3** `lh-web` 新設（node:http で `/rpc` + `/events` SSE + SPA 配信）・`lh serve` 廃止
- [x] **S4** web クライアントを契約準拠 JSON-RPC 化（REST fetch → `/rpc`、SSE は notification）
- [x] **S5** `lh`(cli) を Node + core 直叩き（HTTP 廃止、service/serialize 層を新設）
- [x] **S6** v1 UI 削除（本リライトでは `ui.html`/`ui.ts` を最初から持ち込まず、lh-web は v2 のみ配信）
- [ ] **S7** 再レイヤリング + docs/scripts/skills 整理
