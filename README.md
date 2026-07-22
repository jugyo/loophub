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
npm run serve                   # lh-web と lh-worker を開発用に同時起動
```

`serve` は開発時の web UI と resident worker をまとめて扱う名前として採用している。
`lh-web` と `lh-worker` の個別スクリプトも引き続き利用できる。既存の `npm run up` は互換用に残しており、
`npm run up -- --port 8731` のような引数も両プロセスへ転送する。出力には `[web]` / `[worker]` の
プレフィックスが付き、`serve` のどちらか一方が終了すると、もう一方も停止して `serve` 全体が終了する。
`Ctrl-C` でも両方を停止できる。

起動と終了を確認するには、別のターミナルで `npm run serve` を実行し、ログに `lh-web listening` と
`lh-worker started` が出た後、どちらかの子プロセスを終了する。両方のプロセスと `serve` が終了すれば、
開発用プロセス群の終了動作を確認できる。

`lh-web` は Vite を middleware mode で内蔵し、`/rpc` と `/attachments` route 以外を Vite に委譲する。
単一コマンド・単一ポートで API も SPA も HMR も提供する（別プロセスの dev server は不要）。
`--port <n>` でポートを変更できる。
既定では loopback（`127.0.0.1`）にのみ bind する（内蔵 Vite が web/ のソースを配信するため）。
LAN から開きたいときだけ `LOOPHUB_HOST=0.0.0.0` を指定する。

SPA は常に自分の lh-web から same-origin・same-process で配信される。frontend を単体起動して `/rpc`
を別プロセスの backend へ向ける経路は無い。

> worktree のコードで UI 開発・動作確認をするときは、その worktree の lh-web を prod とは別ポート・
> 別 HOME で起動する（prod の DB / ポートに触れない）:
>
> ```sh
> LOOPHUB_HOME=$(mktemp -d) npm run lh-web -- --port 8731   # worktree 内で
> ```
>
> http://localhost:8731 を開いて確認し、終わったら停止する。

## lh-worker（イベント駆動ランナー・v1）

`lh-worker` は events テーブルを id cursor で tail する常駐プロセス。リポジトリルートの
`.loophub/workflow.yml`（VCS 管理・可搬）を読み、`issue.opened` / `pull_request.opened` で
`run` のシェルコマンドを cwd = 対象リポジトリの `local_path` で実行する。

```yaml
# .loophub/workflow.yml
on:
  issue.opened:
    - run: ./scripts/triage.sh
    # Prefer fire-and-forget launchers; do not block the worker on long agent runs.
    - run: lh workflow start "$LH_ISSUE_NUMBER" --workflow default --herdr
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
> 重い処理（`lh workflow start ... --herdr` 等）は run 内で外部アプリへ起動を依頼して即 return する設計。
> 長時間ブロックする run は後続イベントを止めるため、自前でバックグラウンド化(`... &` / nohup)するか
> 即終了させること。
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
lh issue create --title "do the thing"
lh issue create --title "stacked change" --workspace integration/stack
lh workflow start 1 --workflow default --herdr
lh pr create --head feature-x --base main --title "impl" --issue 5
```

別 checkout を指す場合は `LOOPHUB_ROOT=/path/to/loophub lh ...`。CLI は `core/service` を直接呼び、
サーバープロセスは不要（同じ `LOOPHUB_HOME` の SQLite に直接読み書きする）。

### Workspace コンテキスト

`LOOPHUB_WORKSPACE` は、現在の workspace をローカルブランチ名で表す。workspace セクションの
New issue や `lh issue new --target-branch <branch>` は、この環境変数を起票セッションへ渡す。
そのセッションで通常どおり `lh issue create` を実行すると、環境値が Issue の `target_branch` に
設定され、後続の Workflow 着手（`lh workflow start`）は同じブランチを PR の base に使う。

`lh issue create --target-branch <branch>` を明示した場合は、その値が `LOOPHUB_WORKSPACE` より
優先される。どちらもない場合は従来どおり `target_branch: null` になる。この環境変数は既存の
workspace ブランチを選ぶコンテキストであり、ブランチを作成しない。`--target-branch` も
既存のローカルブランチだけを受け付ける。

登録済み workspace を明示して起票する場合は
`lh issue create --workspace <branch> --title <title>` を使う。指定先は対象 repository の active な
workspace で、ローカルブランチも存在する必要がある。`--workspace` は `LOOPHUB_WORKSPACE` より
優先され、`--target-branch` との併用はエラーになる。新しい workspace ブランチは先に
`lh workspace create <branch>` で作成・登録する。

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
