<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loophub-logo-dark.svg">
    <img src="docs/assets/loophub-logo.svg" alt="LoopHub" height="40">
  </picture>
</h1>

[![CI](https://github.com/jugyo/loophub/actions/workflows/ci.yml/badge.svg)](https://github.com/jugyo/loophub/actions/workflows/ci.yml)

English: [README.md](./README.md)

**LoopHub は、自分のマシンにある git リポジトリのための、GitHub 風の issue / PR ハブです。**
issue を書いて「開始」を押すと、コーディングエージェント（Claude Code など）が専用の git worktree
の中で実装し、別のエージェントがその結果を独立にレビューします。人間は issue を書くことと、
出てきた PR を merge するかどうかを決めることに集中できます。

リモートのサービスではありません。すべてローカルのプロセスとローカルの SQLite で動きます。

こんな人のためのツールです。

- コーディングエージェントに複数の作業を並行させたいが、ターミナルのタブを行き来して
  「今どれがどこまで進んでいるか」を追うのに疲れている
- エージェントの成果を、チャットのログではなく **diff と PR** として見て判断したい
- 実装したエージェント自身の自己申告ではなく、**独立したレビュー**を挟みたい

![LoopHub の issue 一覧。#1 では workflow が動いていて Execute → Verify → Done の進捗と PR #4 へのリンクが見える](docs/screenshots/issues-overview.png)

## How it works

1. **Issue を作成する。**
2. **workflow を開始する。** LoopHub が PR とその専用 worktree を用意し、
   エージェントをターミナルの pane で起動する。
3. **Execute（実装）** — エージェントが issue を自分で読み、実装し、テストを走らせ、commit して
   PR を更新する。
4. **Verify（検証）** — 別セッションのエージェントが pass / 変更要求を返す。
   変更要求なら Execute に差し戻る。
5. **人間が merge する。**

進行中はブラウザの UI で全リポジトリ横断の状況を見られ、必要なら該当エージェントの pane に
飛び込んで直接指示できる。

用語:

- **Issue** — 解決したい問題と受け入れ条件。
- **Pull request (PR)** — issue に紐づく実装提案。head/base ref、draft/review 状態、merge 結果を持つ。
- **Worktree** — PR 専用の git linked checkout（`loophub/pr-<n>` ブランチ）。作業がお互いを踏まない。
- **Workflow run** — 1 つの issue と PR に対する Execute / Verify の 1 回の実行。

## Prerequisites

LoopHub 自身はビルド不要の TypeScript だが、**いくつかの外部 CLI を PATH 上に必要とする**。
特に **herdr が無いと workflow を開始できない** — つまり中核機能が使えない。

| ツール | 用途 | 入手方法 |
|---|---|---|
| **Node.js >= 22.12.0** | LoopHub 本体（CLI / Web / worker）の実行 | [nodejs.org](https://nodejs.org) |
| **git** | リポジトリ登録、worktree、branch、diff、merge のすべて | OS の標準的な方法で |
| **herdr** | エージェントを起動・配置するターミナルマルチプレクサ。`lh workflow start` はこれを直接呼ぶ | `brew install herdr` — [herdr.dev](https://herdr.dev) |
| **コーディングエージェントの CLI（いずれか 1 つ以上）** | 実際にコードを書く主体 | 例: `claude` / `codex` / `grok` / `cursor-agent` / `opencode` |

## Quick start

clone から UI を開くまで。

**1. LoopHub を取得して依存を入れる**

```sh
git clone <this-repo> loophub
cd loophub
npm install
npm --prefix web install # web/ の依存も入れる（root の postinstall でも実行されるが、ignore-scripts=true でも効くよう明示する）
```

**2. `lh` コマンドを PATH に入れる**

```sh
npm link
lh info # baseUrl / home / dbPath が出れば OK
```

**3. 管理したいリポジトリを登録する**

```sh
lh repo add ~/work/my-project --name me/my-project
```

**4. UI を開く**

```sh
npm run serve # http://localhost:8730 — lh-web + 5つの常駐プロセス
```

issue の作成や workflow の開始は UI から行う。プロセスの起動バリエーション、CLI、データの置き場所は [Processes, CLI, and data](#processes-cli-and-data) を参照。

## Security assumptions

LoopHub は**自分のマシンで自分だけが使うローカルツール**であり、認証・認可の機構を持たない。
`lh-web` の `/rpc` からはシェルコマンドの実行とエージェントの起動ができるので、
**`/rpc` に到達できる者は、あなたのマシンで任意のコードを実行できる**。
そのため既定では loopback（`127.0.0.1`）にのみ bind する。

> **警告**: `LOOPHUB_HOST` をループバック以外（`0.0.0.0` など）にすると、同一ネットワークの誰もが
> 認証なしにあなたのマシンで任意のコードを実行できる状態になる。リバースプロキシの背後に置いたり、
> 公開ホストで動かしたりすることは想定していない。

## Processes, CLI, and data

### Processes

```sh
npm run serve # lh-web + watcher 3種 + dispatcher + job queue をまとめて起動
npm run serve:debug # コンポーネントデバッグ UI を有効にして同じ6プロセスを起動
npm run lh-web # http://localhost:8730 — API + UI を 1 プロセスで（起動時に SPA を build）
npm run lh-worker # events を tail してリポジトリの自動化と常駐 maintenance を実行
npm run lh-watcher-git # ローカル git の状態を観測して event を記録
npm run lh-watcher-github # GitHub の状態を観測して event を記録
npm run lh-watcher-agents # エージェント runtime の状態を観測して event を記録
npm run lh-dispatcher # event を tail して DB 由来の判断と workflow dispatch を実行
npm run lh-job-queue # 外部副作用 job の専用プロセス境界
```

出力には `[web]` / `[git]` / `[github]` / `[agents]` / `[dispatcher]` / `[queue]` のプレフィックスが付く。
`serve` のいずれか一つが終了すると、残りも停止して `serve` 全体が終了する。
`Ctrl-C` でも6プロセスを停止できる。`serve:debug` も同じ6プロセスを起動し、`lh-web` にだけ `--debug` を渡す。
`lh-worker` を単独起動した場合は、従来どおり git sweep も実行する。分離プロセスを使う場合は `serve` を利用する。

### CLI

`lh` は `core/service` を直接呼ぶので、サーバープロセスは不要（同じ `LOOPHUB_HOME` の SQLite に
直接読み書きする）。別 checkout を指す場合は `LOOPHUB_ROOT=/path/to/loophub lh ...`。
全コマンドは `lh` を引数なしで実行すると一覧できる。

```sh
lh issue create --title "do the thing"
lh issue create --title "stacked change" --workspace integration/stack
lh workflow start 1 --workflow default --herdr
lh pr create --head feature-x --base main --title "impl" --issue 5
lh pr merge 3 --method squash
```

### Where data lives

状態は `LOOPHUB_HOME`（既定 `~/.loophub`）配下に置かれ、SQLite は `LOOPHUB_DB`
（既定 `$LOOPHUB_HOME/loophub.db`）。同じ HOME を指すプロセスは同じ DB を見る。
worktree は `$LOOPHUB_HOME/worktrees/<owner>/<repo>/pr-<n>` に作られる。

## Development

規約、レイアウト、テストコマンド、設計原則は [`AGENTS.md`](./AGENTS.md) を参照
（`CLAUDE.md` はそのシンボリックリンク）。

PR と main への push では [CI](.github/workflows/ci.yml) が `typecheck` / `lint` / `test` /
`test:integration` を回す。

## License

[MIT License](./LICENSE)
