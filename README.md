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
core/   純ドメインライブラリ（Node）: db / config / store / git / event-hub / links / watcher
cli/    lh コマンド（core を直 import、HTTP 非経由）
web/    lh-web プロセス（core + JSON-RPC 2.0 + SSE）と SPA
```

## 開発

```sh
npm install
npm test          # vitest（core テスト）
npm run test:watch
```

## 進捗（rearchitect S1–S7）

- [x] **S1** core を Node 化（`node:sqlite` / `node:fs` / `node:child_process` / vitest）
- [ ] **S2** MCP 流 JSON-RPC 2.0 + JSON Schema 契約 + SSE（REST 置換）
- [ ] **S3** `lh-web` 新設・`lh serve` 廃止
- [ ] **S4** web クライアントを契約準拠 JSON-RPC 化
- [ ] **S5** `lh`(cli) を Node + core 直叩き
- [ ] **S6** v1 UI 削除
- [ ] **S7** 再レイヤリング + docs/scripts/skills 整理
