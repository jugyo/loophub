# rdv — crit 方式エージェント間メッセージング設計

エージェント CLI（Claude Code / Codex / Gemini CLI など）のセッション同士が会話するための、
ローカル完結型メッセージ交換ツール。独立プロダクトとして設計する。
作業名は **rdv**（rendezvous）。

## 背景と着想

2 つの既存プロダクトの観察から出発する。

- **agmsg**（fujibee/agmsg）: SQLite(WAL) を共有メッセージバスにしたエージェント間会話。
  配信は Claude Code の Monitor tool / Stop hook に依存し、エージェント CLI ごとに
  hook 設定を配る必要がある。人間が会話を観戦・介入する UI がない。
- **crit**（tomasz-tomczyk/crit）: レビューツールだが、配信機構が独創的。
  エージェント自身が `crit` を背景タスクで spawn し、CLI はデーモンへの long-poll
  （HTTP タイムアウト 24h）でブロックする。人間がレビューを終えるとデーモンが応答し、
  CLI が **結果を stdout に出力してプロセス終了**する。エージェントはツール結果として
  それを受け取り、会話が再開する。**プロセス終了そのものが配信**であり、
  hook・セッション resume・pane 注入を一切使わない。

rdv はこの crit の配信方式を汎用のメッセージ交換に一般化する:
**受け手がブロッキングプロセスを張り、新着メッセージがそのプロセスの終了として届く。**

## ゴール / 非ゴール

### ゴール

- 同一マシン上の複数エージェントセッション間の非同期メッセージ交換（DM とスレッド会話）
- エージェント CLI 非依存。必要なのは「シェルコマンドを背景実行し、終了時に結果を受け取れる」
  ことだけ。hook 設定・Monitor tool・pane 注入を前提にしない
- 人間が会話を **ブラウザで観戦し、一参加者として介入できる**（crit からの最重要の輸入品）
- 失敗は見えるところに出す。自動リトライ・自動復旧より、人間が気づいてリカバリできる設計

### 非ゴール

- マシンをまたぐ転送（ネットワーク透過）。ローカル 1 ホスト完結
- 認証・暗号化。localhost バインドのみの信頼モデル
- 配信保証の作り込み（exactly-once 等）。取りこぼしは履歴コマンドで人間/エージェントが回復する
- 実行中エージェントへの割り込み（push）。待ち受けていない相手には届かないことを仕様として受容する

## コアアイデア: プロセス終了 = 配信

```
agent A のセッション                     agent B のセッション
──────────────────                      ──────────────────
rdv send --to B "レビュー頼む"
rdv recv --block  ──┐                   rdv recv --block ──┐ (背景タスクでブロック中)
                    │                                      │
                    │        rdv daemon                    │
                    │   ┌────────────────────┐             │
                    └──▶│ long-poll /api/wait │◀───────────┘
                        │ SQLite (single      │  B 宛メッセージ着 → B の wait に応答
                        │  writer = daemon)   │──▶ B の recv が stdout に本文を出力して exit
                        └────────────────────┘      └─▶ B のツール結果として届き、会話再開
                              ▲
                              │ 観戦・介入
                        human (Web UI)
```

- 送信: `rdv send` はデーモンに HTTP POST して即終了（fire-and-forget）
- 受信: `rdv recv --block` はデーモンに long-poll。新着が来たら本文を stdout に出して終了
- エージェントは recv を **背景タスク**で走らせる。ブロック中も他の作業を続けられ、
  終了時にハーネスがエージェントを起こす（Claude Code の `run_in_background` と同じ流儀）
- 返信したら再び recv を張り直す。両側がこれをやると会話になる

crit と同じく、これは **pull（自発的な待ち受け）** である。協調的なプロトコルであり、
待ち受けを張っていないセッションには届かない。agmsg が hook で解いた問題を
「解かない」ことで単純化するのが設計上の賭けであり、
「会話に参加する意思のあるエージェント同士」という用途ではこの前提は自然に満たされる。

## アーキテクチャ

```
rdv CLI ──HTTP(localhost)──▶ rdv daemon ──▶ SQLite (~/.rdv/rdv.db)
   │                            │
   │                            └──▶ Web UI (localhost:port, SSE)
   └── stdout/exit code がエージェントとの契約
```

| 構成要素 | 役割 |
|---|---|
| **daemon** | ユーザーごとに 1 プロセス。全状態を所有する唯一の writer。HTTP API と Web UI を提供 |
| **CLI** | 薄いクライアント。デーモン未起動なら自動 spawn（crit と同じ）。DB には直接触らない |
| **Web UI** | スレッド一覧・タイムライン表示（SSE でライブ更新）。人間も `human` 名義で投稿できる |
| **SQLite** | `~/.rdv/rdv.db`。writer はデーモンのみなので WAL 等の多重書き込み対策は不要 |

デーモンを挟む（agmsg のような「CLI が直接 DB を叩く」方式にしない）理由:

1. long-poll の待ち合わせ・起床はメモリ内で完結し、ポーリングが不要になる
2. 書き込みがデーモンに直列化され、並行制御を DB 層で頑張らなくてよい
3. Web UI・SSE・将来の拡張の置き場所が最初からある

## データモデル

```sql
CREATE TABLE agents (
  name        TEXT PRIMARY KEY,          -- "planner", "coder", "human"
  created_at  TEXT NOT NULL,
  last_seen   TEXT
);

CREATE TABLE threads (
  id          INTEGER PRIMARY KEY,
  title       TEXT,                      -- 省略可。DM は自動命名 "A ↔ B"
  created_at  TEXT NOT NULL
);

CREATE TABLE thread_members (
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  agent       TEXT NOT NULL REFERENCES agents(name),
  cursor      INTEGER NOT NULL DEFAULT 0,  -- 配信済みの最終 message id
  PRIMARY KEY (thread_id, agent)
);

CREATE TABLE messages (
  id          INTEGER PRIMARY KEY,       -- 全体で単調増加
  thread_id   INTEGER NOT NULL REFERENCES threads(id),
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

- **メッセージはスレッド宛**。DM は「2 人だけのスレッド」の糖衣であり、特別扱いしない
- 未読管理は **参加者ごとの cursor**（配信済み最終 id）。既読フラグの行を増やさない
- 人間も `agents` の一行（`human`）。データモデル上、人間とエージェントを区別しない

## CLI

```sh
rdv send --to <agent> "<body>"        # DM（スレッド自動作成/再利用）
rdv send --thread <id> "<body>"       # スレッドへ投稿
rdv recv --block [--timeout <sec>]    # 新着を待つ。着いたら出力して exit 0
rdv recv                              # ノンブロッキング。未読があれば出力、なければ exit 3
rdv threads                           # 自分が参加するスレッド一覧
rdv history --thread <id> [-n 50]     # 履歴（cursor を動かさない。取りこぼし回復用）
rdv thread new --title <t> --members a,b,c   # グループスレッド作成
rdv whoami / rdv register <name>      # 識別
rdv status / rdv stop                 # デーモン状態 / 停止
```

### 識別

- 自分の名前は `--as <name>` フラグ、なければ環境変数 `RDV_AGENT`、なければ設定ファイル。
  エージェント起動側（人間やオーケストレータ）が `RDV_AGENT=coder claude ...` のように渡すのが基本形
- **同一名の同時 wait は排他**（agmsg の actas ロックと同じ）。二重に `recv --block` すると
  後発がエラーで即終了する。どのセッションが誰なのかを曖昧にしないため

### stdout 契約（エージェント向けの要）

`recv` の出力は「人間向け表示」ではなく「エージェントの次の行動を導くプロンプト」。
crit が stdout に整形済み指示文を出すのと同じ発想で、フッターに定型指示を付ける:

```
[thread 12: planner ↔ coder]
planner (2026-07-22 14:03):
> auth モジュールの分割案をレビューして。案は thread 12 の #41 に貼った。

---
To reply: rdv send --thread 12 "<your message>"
Then resume waiting: rdv recv --block   (run in background)
```

- exit code: `0` = メッセージあり / `3` = なし（timeout 含む） / `1` = エラー。
  エージェントが分岐しやすいよう、タイムアウトと異常を混ぜない
- `--json` で構造化出力も可能にする（オーケストレータ用）

### 配信セマンティクス

- `recv` はデーモンが未読を返した時点で cursor を進める（**at-most-once 寄り**）。
  recv プロセスが出力直前に死ぬと取りこぼすが、`rdv history` で全文をいつでも読める。
  ack 二段構えの複雑さより「シンプル + 可視 + 人間/エージェントがリカバリ可能」を取る
- long-poll のタイムアウトは crit に倣い実質無期限（24h）。`--timeout` で短くもできる
  （背景タスク通知のないエージェント CLI 向けのフォールバック。後述）

## HTTP API（デーモン）

```
POST /api/send      {from, to?|thread_id?, body}        → {message_id, thread_id}
POST /api/wait      {agent, timeout_sec?}               → 未読が生じるまでブロック → {messages: [...]}
GET  /api/threads?agent=
GET  /api/history?thread_id=&limit=
GET  /api/events    (SSE; Web UI 用)
POST /api/register  {name}
```

- バインドは `127.0.0.1` 固定。ポートはランダム、`~/.rdv/daemon.json` に
  `{pid, port, started_at}` を記録して CLI が発見する（crit のセッションレジストリと同型）
- 認証なし。ローカルユーザーを信頼する

## Web UI（観戦と介入）

agmsg に無く crit にあるものの中で最も価値が高い部分。

- スレッド一覧 + タイムライン。SSE でライブ更新。エージェント別に色分け
- 人間はどのスレッドにも `human` として投稿できる。投稿は他の参加者の wait を普通に起こす
  — **人間の介入とエージェントの発言をプロトコル上区別しない**のが要点
- 「今 wait を張っているのは誰か」を表示（デーモンは接続中の /api/wait を知っている）。
  会話が止まっているとき「相手が待ち受けていないから」がひと目で分かる — 失敗の可視化

## エージェント統合

配布物は各エージェント CLI 向けの **スキル/プロンプト片のみ**。hook 設定は配らない。

### Claude Code（skill）

```markdown
# rdv — 他のエージェントと会話する
- 会話を始める/返信する: `rdv send --to <name> "<message>"`
- 返事を待つ: `rdv recv --block` を run_in_background: true で実行し、
  完了通知が来たら stdout を読んで対応する。待っている間は他の作業を続けてよい。
- 送りっぱなしで待たないと返事は永遠に届かない。返事が要るなら必ず recv を張る。
```

### 背景タスク通知のない CLI（フォールバック）

`rdv recv --block --timeout 300` を**フォアグラウンド**で回す。exit 3（新着なし）なら
そのターンは先に進み、次のターンの頭でまた張る。ターン粒度の遅延を受容する
（agmsg の turn モードに相当するが、hook でなくエージェント自身の行動規範として書く）。

## デーモンライフサイクル

- CLI が `daemon.json` を見て、生きていなければ自動 spawn（デタッチ、crit と同じ）
- 常駐し続ける。アイドル自動終了はしない（複雑さの割に得るものがない）。`rdv stop` で明示停止
- クラッシュ時: 次の CLI 呼び出しが検知して再 spawn。ブロック中だった recv は
  接続断でエラー終了する — エージェントにはエラーとして**見え**、張り直せばよい

## agmsg / crit との対比

| | agmsg | crit | rdv |
|---|---|---|---|
| 目的 | エージェント間会話 | 人間→エージェントのレビュー | エージェント間会話 + 人間の観戦/介入 |
| 状態 | SQLite(WAL) を各プロセスが直接読み書き | デーモンがレビュー JSON を所有 | デーモンが SQLite を所有（単一 writer） |
| 配信 | Monitor tool / Stop hook（CLI ごとに hook 配布） | ブロッキング CLI + プロセス終了 | 同左（crit 方式）。hook 不要 |
| 人間の位置 | なし | レビュアー（主役） | 一参加者（エージェントと同格） |
| 会話の形 | DM 中心 | コメントスレッド（コンテンツにアンカー） | スレッド（自由テキスト、アンカーなし） |

## MVP

1. デーモン + SQLite + `send` / `recv --block` / `threads` / `history`（Web UI なし）
2. Web UI 観戦（読み取り + SSE）
3. Web UI からの人間の投稿、wait 中エージェントの表示
4. Claude Code skill と他 CLI 向けプロンプト片、`--json`

2 エージェント間の会話は MVP の 1 で成立する。まずそこで配信方式の手応えを確かめる。

## 未解決の論点

- **名前空間**: agmsg の team に相当する区切り（プロジェクトごとの分離）を入れるか。
  MVP はユーザーごと単一空間で始め、必要になったら `--home`（`RDV_HOME`）の切り替えで逃がす
- **メッセージへのコンテンツアンカー**: crit の file:line アンカーは強力だが、
  汎用メッセージングでは本文にパスを書けば足りることが多い。入れるとしても後
- **オーケストレーションとの関係**: 「A に投げて B に渡す」のようなルーティングは
  rdv の外（各エージェントのプロンプト側）に置く。rdv は土管に徹する
