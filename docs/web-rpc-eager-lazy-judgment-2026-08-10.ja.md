# Web UI 派生データの eager / lazy 判断（#140）

## 目的とスコープ

#130（`docs/web-rpc-data-inventory-2026-08-10.ja.md`、`main` の commit `e17f2554` にマージ済み）の
棚卸しを起点に、
Web UI が表示に使う派生データそれぞれについて、**先回りして計算しておく（eager）か、
要求されたときだけ計算する（lazy）か**を判断し、その根拠とドライバ指標を記録する。

本ドキュメントは判断の記録のみを目的とする。実装（`jobs` テーブルの追加、
watcher/dispatcher/job-queue のプロセス分割、projection テーブルの導入）は行わない
（#140 本文の Out of scope どおり）。コード・スキーマは変更していない。

## 意思決定ポイント（人間の回答で確定済み・2026-08-10）

長文の前に結論だけ示す。詳細な根拠は各節を参照。下記 4 点はすべて人間の回答（PR comment #285）で
確定した。

| # | 判断ポイント | 人間の決定 | 本レポートの推奨 | 後続の実装項目 |
| --- | --- | --- | --- | --- |
| P1 | 枠組み（watcher / dispatcher / job queue）を実装ターゲットとして確定する | **確定する** | a) 確定 | watcher/dispatcher/job queue の実装（表示は lazy のままを基本に） |
| P2 | `pageData/issueList` の eager 化をどの案でやるか | **案 C**（理由は下記） | a) 案 C | mergeable_state + diff 集計の投影（pull_status 相当） |
| P3 | git-cache（`core/git-cache.ts`）を廃止するか | **廃止する** | b) 現状維持だったが決定どおり廃止 | git-cache の削除（pull-status-cache は残す） |
| P4 | `pulls/diff` の部分 eager（head 移動時に diff + 行座標を投影）をやるか | **やる** | やる | diff + 行座標の投影 |

**案 C を案 B より推す理由（P2 の回答）**

- **eager にすべき部分は「SHA ペアで決まるスライス」だけ**: mergeable_state と diff 集計は
  (baseSha, headSha) の関数で、陳腐化の心配なく投影できる。しかも worker の pull sweep が**同じ計算を
  既に**している（`currentMergeableState`）。
- **案 B が追加で投影する非決定的フィールドはコストに見合わない**: `working`（worktree の git status）
  と `worktree_path`（fs stat）は ref が動かなくても変化し（worktree が dirty/clean になる）、
  投影しても陳腐化リスクが残る。しかも軽い（worktree が実在する open PR のみ git status 1 回）。
  B の利点（表示が完全に DB 読みになる）は、この 2 フィールドまで DB に乗せても消えない陳腐化を
  抱えることと引き換え。
- **実装範囲**: B は非決定的フィールドの整合性設計（いつ更新するか）まで必要だが、C は pull sweep の
  既存計算結果を 1 行書くだけで済む。増員シナリオ（イベント量 ~2 倍）でも C で web のリクエストパス
  から git の主 fan-out が消える効果は B と同等。
- **枠組みとの整合**: P1 で枠組み確定。枠組みでは表示は web のリクエストパス計算のまま（lazy）なので、
  投影テーブルはどちらも枠組み外の拡張になる。最小の逸脱で最大の効果を取るなら C。

**P3 廃止の影響（git-cache 依存の整理）**

- git-cache が吸収していたのは SHA 入力コマンドの 60s 再利用（ダイアログ等の再表示、issueList の
  `base_commits_behind`）のみ。open PR の主 fan-out は別物の pull-status-cache が吸収しており、こちらは
  残す。本レポートの各判断は git-cache 非依存で記述済み。
- 廃止後は `pulls/diff`・`pageData/pullDetail`・`pulls/debug`・`repos/commitFiles` の再表示が毎回 git を
  spawn する。P4（pulls/diff の部分 eager）がこの影響を直接吸収する。

**確定済み（本 PR のスコープ内・追加の決定不要）**

- `pulls/githubStatus` は **eager 化を実施**（連携使用予定あり・賛成、thread #22）。実装は github merge
  sweep に便乗。残るは実装 issue の切り出し。
- コミット範囲は **本 PR で生成したドキュメントのみ**（thread #20）。枠組み文書はコミットしない。
- 稼働エージェント数は **2 倍以上に増える見込み**（thread #21）。増員シナリオをコスト試算に反映済み。
- lazy 確定: `pulls/fileAtRef` / `repos/commitFiles` / `pulls/debug` / `pageData/pullDetail` /
  `workflowRuns/stateForPull` / `repos/mergeMode`。`repos/originSync` は eager 寄りだが優先度低。

## データソースと再現手順

本ドキュメントの全数値・主張は以下の実物から取っている。再現する場合は同じ手順を踏むこと。

| 情報 | ソース | 取得方法 |
| --- | --- | --- |
| RPC サーフェスの棚卸し（契約・配線・発火・dead） | `docs/web-rpc-data-inventory-2026-08-10.ja.md`（#130 / PR #131） | `main`（commit `e17f2554`）にマージ済み |
| pageData/issueList の実装 | `core/service/page-data.ts:18-66` | コード読解 |
| issue 行・linked PR サブ行のシリアライズ | `core/serialize-status.ts:195-323` | コード読解 |
| git fan-out の内訳（SHA ペアキャッシュ） | `core/pull-status-cache.ts:1-129` | コード読解 |
| git コマンドキャッシュ（TTL / 対象） | `core/git-cache.ts:33-96` | コード読解 |
| worker の定期 sweep の間隔 | `worker/maintenance.ts:23-50` | コード読解 |
| head SHA 監視（pull_request.updated の発火元） | `core/watcher.ts:8-33` | コード読解 |
| mergeable state の計算（sweep 共通） | `core/pull-mergeable-state.ts:17-33` | コード読解 |
| 通知生成が worker 専有になった経緯 | `core/service/notifications.ts:152-159`・AGENTS.md | コード・README 読解 |
| herdr snapshot（DB projection の前例） | `worker/maintenance.ts:482-521` | コード読解 |
| events/list ポーリング間隔 | `web/src/lib/use-loophub-events.ts:12-13` | コード読解 |
| worker/status の heartbeat / stale | `core/worker-protocol.ts:4-7` | コード読解 |
| イベント量・行数の実測 | `~/.loophub/loophub.db`（この環境の HOME） | `node --experimental-sqlite` で `SELECT ... FROM events` 等（下記クエリ） |
| pageData/issueList 相当の実測レイテンシ | この worktree | `time lh issue list --json`（下記） |
| #112 の計測値（合成 12 PR） | `docs/issue-list-workflow-run-state.ja.md:29-58` | ドキュメント引用 |
| #102 の原因調査（直列化 / sweep 因果なし / WAL） | `docs/slow-rpc-root-cause.ja.md`（PR #104 の worktree。`main` 未マージ） | ドキュメント引用 |
| #140 が参照する判断の枠組み（概念） | `docs/worker-event-architecture-concept.ja.md` | プライマリ checkout `/Users/jugyo/workspace/jugyo/loophub/docs/`（untracked、2026-08-09 作成） |
| #140 が参照する判断の枠組み（詳細設計） | `docs/worker-event-architecture-design.ja.md` | プライマリ checkout `/Users/jugyo/workspace/jugyo/loophub/docs/`（untracked、2026-08-09 作成） |

### 実測クエリ（2026-08-10 時点のスナップショット）

```
node --experimental-sqlite --disable-warning=ExperimentalWarning -e '
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.env.HOME + "/.loophub/loophub.db");
db.prepare("SELECT COUNT(*) c FROM events").get();                                  // 17,771
db.prepare("SELECT COUNT(*) c FROM events WHERE repo_id IN (SELECT id FROM repos WHERE full_name=?)")
  .get("jugyo/loophub");                                                            // 15,050
db.prepare("SELECT type, COUNT(*) c FROM events GROUP BY type ORDER BY c DESC LIMIT 10").all();
db.prepare("SELECT substr(created_at,1,10) d, COUNT(*) c FROM events WHERE repo_id IN (SELECT id FROM repos WHERE full_name=?) GROUP BY d ORDER BY d DESC")
  .all("jugyo/loophub");
db.prepare("SELECT COUNT(*) c FROM github_pull_status").get();                      // 0
db.prepare("SELECT COUNT(*) c FROM github_pulls").get();                            // 0
'
```

```
time lh issue list --json > /dev/null      # 実 DB・この worktree で 1.5–1.7s（open PR 6 本）
```

行番号は本調査時点（2026-08-10、`main` HEAD `e3775368`）のもの。以後の変更でずれる。

## 判断の枠組み

### 1. 問題文のたたき台表（#140 本文）

| 条件 | eager が向く | lazy が向く |
| --- | --- | --- |
| 出力サイズ | 小さい | 大きい（テキスト blob 等） |
| 読まれる確率 | 高い・複数ページから参照される | 低い・特定操作時のみ |
| 変化頻度 vs 読まれる頻度 | 変化 ≦ 読まれる頻度 | 変化 ≫ 読まれる頻度 |
| 計算コスト | 重いほど eager の価値が高い | 軽いなら lazy で十分 |
| fan-out | 小さい | 1 変化が多数へ波及するものは要注意 |

さらにメモ化（projection）が成立するかの判定:

- **不変な入力で決まるもの**（例: `diff(base_sha, head_sha)`）→ キャッシュが陳腐化しないので
  eager / lazy どちらも選べる
- **動き続けるものとの関係で決まるもの**（例: conflict 状態は「自分の head」と「base ブランチの今の
  先端」の関係）→ 同じキーが再訪されないためメモ化は成立せず、event 駆動の再計算か定期ポーリングになる

### 2. 本調査で確認した「既に存在する最適化」が判断に与える影響

このコードベースには、判断前に考慮すべき既存メカニズムが 4 つある。eager / lazy の判断は
これらとの役割分担として記録する。

**(a) in-process の git コマンドキャッシュ** — `core/git-cache.ts`（#2350）
- 引数の全 revision が解決済み SHA のときだけ、60s TTL・上限 32 MiB でキャッシュ。
  `diff` / `log` / `merge-base` / `rev-list` / `show` が対象（`:65-96`）。
- `rev-parse` / `status` / worktree 系は意図的に除外（ref・worktree の現在位置は常に生の値が必要）。
- **廃止が決定した（PR comment #285）**: 新設計（watcher / dispatcher / job queue）で git が
  job queue に集約され、プロセスごとの重複キャッシュ（web と worker で別々に持つ #102 の指摘）が
  邪魔になるため、`core/git-cache.ts` を削除する。後続 issue で実装する。
  本レポートの各判断は、git-cache の有無で結論が変わらないよう根拠を書き直してある
  （git-cache が吸収しているのはダイアログ等の SHA 入力コマンドの再利用のみで、open PR の主 fan-out
  は別物の pull-status-cache（次項 b）が吸収しており、こちらは残す）。
  廃止後は `pulls/diff` 等の再表示が毎回 git を spawn するため、P4（pulls/diff の部分 eager）が
  その影響を直接吸収する。

**(b) in-process の SHA ペアキャッシュ** — `core/pull-status-cache.ts`（#1668）
- open PR の git fan-out（merge-preview / commits-ahead / effective-diff / diff-stat）を
  `(baseSha, headSha)` ペアで LRU 512 にキャッシュ（`:42-44, 111-124`）。
- 同一ペアの再取得は git subprocess を 0 本で済ませる。#112 以降の一覧 refetch の主コストを吸収。
- 意図的に除外: `working`（worktree dirty）と review state、`rev-parse`（ref 移動の検出そのもの）。

**(c) worker が全 open PR の mergeable state を既に定期計算している**
- pull sweep（5s）が head SHA 監視 + merge-ready 通知生成（`currentMergeableState` を全 open PR に、
  `worker/maintenance.ts:235-264`）。
- conflict sweep（15s）が clean→conflict 遷移検知（同じ `currentMergeableState` を全 open PR に、
  `worker/maintenance.ts:269-298`, `core/pull-conflict-events.ts:44-79`）。
- つまり「表示のために web が計算している mergeable/diff ステータス」と**同じ計算を worker が
  別目的（通知・conflict 検知）で既に実行している**。ただしその結果は DB に保存されず、
  通知・event の形でのみ残る。

**(d) 「worker が DB に projection を書いて表示は DB 読み」の前例が 2 つ**
- 通知生成（#118）: merge-ready / over-budget / human-attention 通知は `lh-worker` の pull sweep
  のみが生成し、`notifications.list` は純粋な DB 読み（`core/service/notifications.ts:152-159`、
  AGENTS.md の「Notification Center entries ... are generated only by lh-worker」）。
- herdr snapshot（#1665）: `terminal/sessions` は worker の 3s sweep が DB に書く snapshot を読む
  （`worker/maintenance.ts:482-521`）。

**(e) #140 が参照する判断の枠組み（watcher / dispatcher / job queue）**

#140 本文が参照する枠組み文書が実在する（プライマリ checkout の untracked ファイル。
`docs/worker-event-architecture-concept.ja.md` / `docs/worker-event-architecture-design.ja.md`）。
本調査当初の検索は worktree と git の ref に限定しており、これを発見できていなかったが、
review 165 の指摘で修正する。枠組みの要点は次のとおり:

- 役割を 3 つに分ける: **watcher**（外部の状態を観測して event に記録するだけ、判断しない）、
  **dispatcher**（event を見て「job を積む or notification を DB 直書き」を判断する、DB の外に出ない）、
  **job queue**（job を実行し git / gh / agent ランタイムへの唯一の窓口になる）。
- mergeable state の観測は **watcher の仕事**であり、現行の `currentMergeableState` 計算は
  `lh-watcher-git` に移す（設計 :121）。clean 遷移を検知したら event を書き、
  通知作成の判断は dispatcher が受ける（設計 :122）。
- Web UI は dispatcher を経由せず `jobs` へ直接書く（概念 :64-69）。「表示のための git 計算」は
  job queue 化の対象に含まれておらず、`pulls/diff` は**「変更なし（lh-web で直接同期実行のまま）」**
  と明記されている（設計 :127、概念 :27-30）。
- **本枠組みは「表示用の mergeable_state を DB に永続化する projection テーブル」を設計していない**。
  枠組みでの mergeable state の出力は通知・conflict などの event であり、表示は従来どおり web の
  リクエストパスで計算する（in-process キャッシュで緩和）。本ドキュメントの推奨案 C（後述）は
  この枠組みの外にある拡張案であり、その位置づけを明示して記録する。

以上から、本 issue の判断は「eager 化の手法が成立するか」ではなく「**どのデータをどの単位で
worker のどの tick に載せるか**」「**既存の in-process キャッシュで足りている部分に eager 化を
重ねる価値があるか**」、そして「**枠組み（watcher / dispatcher / job queue）の中でどこに置くか**」
に帰着する。

### 3. ドライバ指標（実データ）

#### イベント量（実 DB、jugyo/loophub）

| 日 | 件数 |
| --- | ---: |
| 2026-08-05 | 357 |
| 2026-08-06 | 2,291 |
| 2026-08-07 | 2,458 |
| 2026-08-08 | 6,400 |
| 2026-08-09 | 3,267 |
| 2026-08-10 | 279（部分日） |

- フル 5 日平均 ≈ **2,955 件/日 ≈ 123 件/時**。ピーク日（08-08）は **≈ 267 件/時**。
- `agent_session.usage_updated` は全体 17,771 件中 **11,808 件（66.4%）** で、イベント量の主ドライバ。
- events 総行数 17,771（計測時点）。これは #130 棚卸し時点の 16,582 から増加している（DB は常時書込）。
- **増員シナリオ（人間の回答、thread #21）**: 稼働エージェント数は 2 倍以上に増える見込み。
  `agent_session.usage_updated` は稼働エージェント数に比例するため、イベント量は現在の実測の
  約 2 倍（平均 ~246 件/時、ピーク ~534 件/時）に達しうる。この前提でコスト試算の増員シナリオを
  見積もる（下記）。

#### Web 側の定期ポーリング（#130 棚卸しの計測値）

| 対象 | 間隔 | 根拠 |
| --- | ---: | --- |
| `events/list` | 可視時 1.5s = 1 タブあたり最大 **2,400 回/時** | `web/src/lib/use-loophub-events.ts:12` |
| `worker/status` | `stale_at` まで（compatible 時 ~1 回/分） | `core/worker-protocol.ts:4,7`（heartbeat 5s / stale 60s） |

#### pageData/issueList の実コスト

| 計測 | 値 | 条件 |
| --- | ---: | --- |
| `lh issue list --json`（この worktree・実 DB） | **1.5–1.7s**（プロセス全体） | open PR 6 本、CLI 起動込み |
| #112 の計測（`docs/issue-list-workflow-run-state.ja.md:51`） | **3,582.8ms** | 合成 repo・12 PR・`pageData/issueList` 1 本 |

#112 の計測では、この時間のほぼ全部が「行ごとの git fan-out」で、run state（DB 読み）は
git を増やしていない（同 docs:56-58）。

## 判断一覧（サマリ）

eager / lazy 判断が必要なのは「git 由来またはネットワーク由来の値を返す read 系」だけである。
DB・config 由来の read 系（`repos/list`・`issues/get`・`comments/list`・`pulls/usage`・
`workflowRuns/totalCost`・`notifications/list`・`terminal/sessions`・`settings/get`・`stats/get`
など）は計算コストが軽く、eager 化の価値がないため対象外とする（棚卸しの「seed」「dead」
「mutation」も同様）。

| データ | RPC | git / ネットワーク由来の実体 | メモ化成立 | 判断 | 根拠 |
| --- | --- | --- | --- | --- | --- |
| issue 一覧（行 + linked PR サブ行） | `pageData/issueList` | 行の linked PR ごとに git fan-out | 大部分は (baseSha, headSha) に成立 / working・worktree_path は不成立 | **eager 寄り（後述の推奨案 C）** | 読まれる確率高・コスト重い（3,582.8ms / 12 PR）・worker が既に同計算を実行中 |
| PR 詳細ページ | `pageData/pullDetail` | diff base 解決 + pullStatusFields + diff files | 一部は SHA ペアで成立 | **lazy（現状維持）** | 表示時のみ・#123/#125 で base 解決を 1 リクエスト 1 回に畳み済み・キャッシュ共有で表示時 1 回分 |
| workflow run の表示状態 | `workflowRuns/stateForPull` | 一部（pullShaStatus・revParse）+ DB | SHA 部分は成立 | **lazy（git 部分は issueList の eager 化に追随）** | 表示時のみ・git 部分は pullShaStatus キャッシュを共有 |
| origin ahead/behind | `repos/originSync` | `remoteUrl` + `currentBranch` + `aheadBehind`（branch 名 → キャッシュ不能） | 不成立（ref の現在位置） | **eager 寄りだが優先度低（現状の event 駆動 lazy で実用十分）** | 値が小さい・変化点が pullFromOrigin と `pull_request.merged` の 2 つに限定（`event-keys.ts:201-203`） |
| GitHub PR ステータス | `pulls/githubStatus` | `gh pr view` のネットワーク呼び出し | 不成立（外部状態） | **eager 化を実施する** | 人間の判断で連携使用予定あり・eager に賛成（thread #22）。TTL 60s の DB キャッシュ済み（`pulls.ts:63,874-900`）・既存の github merge sweep（60s）で先行取得できる。現状この環境は github_pull 0 件で実コスト 0（連携導入後に発生） |
| PR の diff 本文 | `pulls/diff` | `diffFilesBetween` + patch パース + 行座標計算 | SHA 入力で成立 | **部分 eager を実施する（表示は lazy のまま）** | 人間がほぼ必ず開く（read 確率が高い）・表示までのステップが多い（diff base 解決 → patch → 行座標計算）。人間の決定（PR comment #285）で head 移動時に「解決済み base の diff + 行座標」を投影する部分 eager を実施。git-cache 廃止（同じく決定済み）で再表示が毎回 spawn になるのを吸収する |
| 指定 ref のファイル内容 | `pulls/fileAtRef` | `git show` | SHA 解決後は成立 | **lazy 確定** | Markdown プレビュー限定 |
| コミットの変更ファイル | `repos/commitFiles` | `git diff`（commit vs 親） | SHA 入力で成立 | **lazy 確定** | commit 一覧ダイアログ限定 |
| PR デバッグダンプ | `pulls/debug` | diff / log / files / events | 一部 SHA 入力で成立 | **lazy 確定** | debug ダイアログ限定 |
| repo の merge mode 設定 | `repos/mergeMode` | `remoteUrl`（git config）のみ | 不成立 | **lazy** | repo settings 限定・値が小さい |

## pageData/issueList の内訳（git 由来 / DB 由来）

### 処理経路

`pageData/issueList`（`core/service/page-data.ts:18-66`）は
`issues.list` → `issueListItemsJSON`（`core/serialize-status.ts:221-251`）を呼び、ページ slice ごとに
linked PR の `linkedPullDetail`（`:253-323`）を並列計算する。run state は別途
`workflowRuns.statesForPulls` で取得されるが、これは純粋な DB 読みではない: ページ内の distinct ref
ごとに `rev-parse` を 1 回（`refResolver`、`core/service/workflow-runs.ts:2619-2633`）し、各 run の
表示状態の git 部分は行側と同じ `pullShaStatus`（SHA ペアキャッシュ）を使う（`workflowRunState`、
同 :1123-1133）。#112 の「git を増やしていない」は行側が解決済みの SHA ペアとキャッシュを共有する
ことによるものである（`docs/issue-list-workflow-run-state.ja.md:56-58`）。

### サブ行フィールドの由来とキャッシュ性

| フィールド | 由来 | キャッシュ |
| --- | --- | --- |
| `mergeable_state`・`additions`・`deletions`・`changed_files`・`commits_ahead` | git（merge-preview / diff-stat / rev-list） | `pull-status-cache` の (baseSha, headSha) LRU |
| `working`（worktree dirty） | `git status --porcelain`（worktree が存在する open PR のみ） | 非キャッシュ（毎回実行、`pull-worktree.ts:85-104`） |
| `worktree_path` | fs `statSync` | 非キャッシュ（毎回） |
| `base_commits_behind` | git `rev-list --count`（SHA 入力） | 現在は `git-cache`（60s TTL）で再利用。git-cache 廃止時は毎回 spawn（1 回は軽量） |
| `head/base/forkBase sha` | git `rev-parse`（head / base の 2 回、`core/serialize-status.ts:85-89`）。`resolvePullBaseSha` は `base_sha` 保存済みなら git を叩かない（`core/pull-base.ts:13`）、未保存レガシー行のみ `merge-base` | 非キャッシュ（毎回。ref 移動の検出そのもの） |
| `review_state`・`review_gate` | DB（`computeReviewStatus`） | — |
| `total_tokens`・`cost_usd`・`agent_runtime`・`model`・`work_duration_total` | DB（session usage / agent / primary session） | — |
| `github_pull`・`cost_stopped`・`total_comments`・`workflow_rework_count` | DB | — |

ref が動かない限り、**毎回の表示 refetch で実際に git を spawn するのは head / base の
`rev-parse` 2 回/PR（+ base_sha 未記録レガシー行の `merge-base`）と `git status`（worktree PR のみ）**
であり、merge-preview 等の重い部分は既にキャッシュ済みである。一方 ref が動いた直後の
refetch（pull_request.updated の直後）は fan-out 全体が再実行される。

### eager 化できる単位とトリガー

- **単位: PR 単位**。git 由来のほぼ全部が (baseSha, headSha) の関数であり、PR をまたいで共有される
  のは base 側だけ（同一 repo の PR は base ref を共有）。repo 単位の projection は base の 1 回解決
  を節約するが、PR 単位の方が worker の既存計算（currentMergeableState も PR 単位）と整合する。
- **トリガー**: head が動いたとき（watcher `sweepPullUpdates` が `pull_request.updated` を emit、
  `core/watcher.ts:8-33`）と base が動いたとき（sibling merge → `pull_request.merged`、
  `lh pullFromOrigin` → `repos.pullFromOrigin`）。いずれも pull sweep（5s）で検知・実行できる。
- **既存の親和性**: このトリガーと計算は、**pull sweep が既に「head SHA 監視」と「全 open PR の
  mergeable state 計算」を実行している**（`worker/maintenance.ts:235-264`、`core/pull-mergeable-state.ts`）。
  つまり eager 化の追加作業は「既存の計算結果を DB に 1 行書く」に近い。

### 判断のまとめと推奨案

判断基準の各軸で見ると:

- 出力サイズ: 小〜中（行数 × サブ行）。eager 向き。
- 読まれる確率: **高**（repo top の初期ロードに必ず含まれ、表示中は全 repo event で invalidate）。
- 変化頻度 vs 読まれる頻度: 表示中は常時読む。変化は head move / merge のたび（低頻度）。**eager 向き**。
- 計算コスト: 重い（3,582.8ms / 12 PR）。ただし (baseSha, headSha) キャッシュで無変化時の spawn は 0。
- fan-out: PR 単位で、同一 SHA ペアは共有。問題文の「1 変化が多数へ波及」には該当しない。

「推奨案 C」は、`pageData/issueList` の git 由来部分を eager 化する実装形態の呼称。A / B / C の 3 案を
比較し、**案 C が人間の決定（PR comment #285 で選定、#290 で「案 C で良い」と確認）で確定した**。

| 案 | 概要 | 利点 | 欠点 |
| --- | --- | --- | --- |
| **A（in-process キャッシュのみ = 現状）** | git-cache（#2350）と pull-status-cache（#1668）だけに頼る | 実装済み・無変化時の git spawn 0 | ref 移動時は web が計算し、単一 event loop を専有する |
| **B（投影テーブル + worker 書き込み）** | pull sweep が全 open PR の mergeable state を DB の projection テーブルに書き、表示は純粋な DB 読み | 表示が決定的・リクエストパスから git が消える | テーブル・整合性の設計が必要。非決定的フィールド（working / worktree_path）まで DB に乗せると陳腐化リスクが残る |
| **C（ハイブリッド）★決定** | `mergeable_state` と diff 集計（SHA ペアで決まる部分）だけ DB へ投影し、`working` / `worktree_path` は表示時 lazy のまま | B の利点の大部分を最小実装で得る | 非決定的フィールドは表示時に git が残る |

**案 C を案 B より推す理由**（人間の質問への回答、PR comment #285）:

- **eager にすべきは「SHA ペアで決まるスライス」だけ**。mergeable_state と diff 集計は (baseSha, headSha)
  の関数で陳腐化しないうえ、worker の pull sweep が**同じ計算を既にしている**（`currentMergeableState`）。
- **案 B が追加で投影する非決定的フィールドはコストに見合わない**。`working`（worktree の git status）と
  `worktree_path`（fs stat）は ref が動かなくても変化する（worktree が dirty/clean になる）ため、DB に
  乗せても陳腐化が残る。しかも軽い（worktree が実在する open PR のみ git status 1 回）。
- **実装範囲と増員シナリオ**。B は非決定的フィールドの「いつ更新するか」の設計まで必要だが、C は
  pull sweep の既存計算結果を 1 行書くだけで済む。イベント量が 2 倍（thread #21）になっても、web の
  リクエストパスから git の主 fan-out が消える効果は C で B と同等。
- **枠組みとの整合**。P1 で枠組み確定（表示は web のリクエストパス計算のまま = lazy）。投影テーブルは
  どちらも枠組み外の拡張なので、最小の逸脱で最大の効果を取る C を選ぶ。

**推奨案 C（ハイブリッド）**: `mergeable_state` と diff 集計（SHA ペアで決まる部分）は、pull sweep が
既に計算しているので、その結果を DB へ projection し表示は DB 読みにする。`working`・`worktree_path`
（非決定的・worktree の実在依存）は表示時 lazy のままとする。実装コストを最小にしつつ、web の
リクエストパスから git を外す効果が得られる。その効果は #102 の調査結果（`docs/slow-rpc-root-cause.ja.md`、
PR #104）に照らして次のように正しく言い換える:

- #102 が観測した遅延の主因は lh-web の**単一 event loop 内の直列化**である。重い RPC
  （`pageData/issueList` の git subprocess 大量 spawn による CPU/subprocess 占有）が走っている間、
  同じ event loop に載る他の RPC はその完了を待つ（同 doc:108-132）。
- したがって eager 化（リクエストパスからの git 除去）の主たる価値は、**この直列化のドライバを
  web プロセスから外し、表示レイテンシを machine load と git spawn のばらつきから切り離すこと**にある
  （#102 は `pageData/issueList` が p50 6,804ms / max 65,414ms とばらつくことを報告、同 doc:104）。
- #102 は worker の sweep と web の遅延に**因果はない**と結論している（第 3 節「因果はない。」、
  同 doc:134-163）。SQLite は WAL のため writer は reader を止めず、busy_timeout に張り付いた形跡も
  ない（同 doc:165-167）。git index lock 競合も #102 の報告には現れない。**本ドキュメントの前版が
  書いた「SQLite ロック競合」「git index lock 競合」「worker sweep と web の並行 git 操作」という
  根拠は誤りであり、この版で取り下げる。**
- 位置づけの注意: 推奨案 C の projection テーブルは、#140 が参照する枠組み文書
  （`worker-event-architecture-design.ja.md`）には**設計されていない**（mergeable state の観測は
  watcher の仕事として event 出力のみ、表示は web のリクエストパス計算のまま、設計 :121, 127）。
  C は枠組み外の拡張案であり、実装する場合は「watcher の観測結果を表示用に永続化する」追加設計として
  起票する必要がある。

なお「eager 最有力」という問題文の初期評価は支持するが、その効果は「コスト削減」よりも
「**web のリクエストパスから git を外して決定的にする**」ことにある。無変化時の refetch は
pullShaStatus キャッシュで git spawn ゼロであり、eager 化で消えるのは残りの rev-parse 2 回/PR と
git status に限られるため、純粋な計算コストの削減は限定的である。

## 他の候補の判断

### `repos/originSync` — eager 寄りだが優先度低

- 実体は `remoteUrl` + `currentBranch` + `aheadBehind`（`core/service/repos.ts:51-68`）。
  `aheadBehind` は branch 名を渡すため git-cache の対象外（ref の現在位置に依存）。
- 値は「ahead / behind の整数」だけで小さく、repo top の sidebar で常時表示される（読まれる確率高）。
- 一方、変化するのは `repos.pullFromOrigin` の実行時と base の merge（`pull_request.merged`）のみで、
  `event-keys.ts:201-203` が後者だけを invalidate する設計になっている。
  → 変化点が 2 つに限定され、それぞれで refetch が走るため、**現状の event 駆動 lazy で実用上
  十分**。eager にするなら「pull 実行時と merge 時に DB へ書く」だけで済むが、優先度は低い。

### `pulls/githubStatus` — eager 化を実施する（人間の判断: thread #22）

- `gh pr view` のネットワーク呼び出しを、TTL 60s の DB キャッシュ（`github_pull_status`）で包んでいる
  （`core/service/pulls.ts:63,874-900`）。キャッシュ hit は DB 読み、miss のみネットワーク。
- この環境の実 DB では `github_pull_status` 0 行・`github_pulls` 0 件であり、現状の実コストは 0
  （GitHub PR 連携を未使用）。
- 判断: **eager 化を実施する**。人間の判断で「行う予定がある。eager 化に賛成」（thread #22）。
  実装は worker の github merge sweep（60s、既に `gh` を実行中、`worker/maintenance.ts:304-332`）に
  便乗して、表示対象の github_pull のステータスを TTL より先に先行取得する形が候補。
  ネットワークレイテンシが読めない点（#140 本文の eager 寄りの根拠）と、表示のたびに miss で
  ネットワークが発生しうる現状を解消する。実コストは GitHub 連携の導入後に発生する。

### `pageData/pullDetail` / `workflowRuns/stateForPull` — lazy（現状維持）

- どちらも PR detail / issue detail の表示時のみ発火。表示中は PR 関連 event ごとに invalidate されるが、
  git 部分は pullShaStatus キャッシュを共有しており、無変化時は spawn ゼロ。
- `pageData/pullDetail` は diff base 解決を 1 リクエスト 1 回に畳み済み（#123/#125、
  `core/service/page-data.ts:102`）。
- 初期表示のレイテンシが問題になった場合は別途「PR detail の初期ロードを事前計算する」eager を
  検討できるが、現時点の判断は lazy。

### `pulls/diff` — lazy（lh-web 直接実行）だが eager 候補（diff feedback での再検討）

diff feedback（thread #19、review 後の人間の指摘）で当初の「ダイアログ限定 = 読まれる確率が低い」
という根拠は誤りと判明した。diff は人間がほぼ必ず開く（読まれる確率が高い）ため、判断を再検討して
記録する。

- **表示までのステップが多い**: diff base 解決（`resolvePullDiffBaseSha`）→ `diffFilesBetween`
  （patch 取得）→ `parsePatchWithCoordinates`（行座標計算）→ レンダリング。人間のフィードバックでは
  「diff comment 位置の計算などもあり、eager になっていると開く瞬間の計算が消えて嬉しい」とされた。
- **ただしコストは軽い**: 実測 81〜164ms（`docs/worker-event-architecture-design.ja.md:127,162-164`）。
  枠組み文書も `pulls/diff` は「変更なし（lh-web で直接同期実行のまま）」としており、job queue 化しない
  （enqueue→poll/event 待ち→再取得の往復コストが上回る）。なお現在は SHA 入力分が git-cache（60s TTL）
  で再利用されるが、git-cache の廃止が決定したため（PR comment #285）、再表示のたびに spawn する。
- **結論（人間の決定、PR comment #285）**: デフォルトの表示は lazy（lh-web 直接実行）のまま、ただし
  **部分 eager を実施する**。head 移動時に「解決済み base の diff + 行座標」を DB に投影し、開く瞬間の
  計算（diff base 解決 → patch → 行座標計算）を消す。read 確率の高さと git-cache 廃止（再表示で
  spawn が戻る）の両方をこの投影が吸収する。出力が大きい点と、diff base が ref 名依存である点
  （メモ化は (baseSha, headSha) 解決後に成立）が実装時の論点。

### `pulls/fileAtRef` / `repos/commitFiles` / `pulls/debug` — lazy 確定

いずれもダイアログ限定で読まれる確率が低く、出力が大きい（ファイル内容・デバッグダンプ）。
`pulls/fileAtRef` は Markdown プレビュー、`repos/commitFiles` は commit 一覧ダイアログ、
`pulls/debug` は debug ダイアログという特定操作のみで発火する。SHA 入力分は現在 git-cache で再利用
されるが、廃止時は毎回 spawn（1 回は軽量）となり、lazy 判断自体は変わらない。

### DB・config 由来の read 系 — 判断対象外

計算コストが軽く（単純な SELECT / config 読み）、eager 化の価値がない。
既に eager 化の前例が実装済みのものもある:
- `notifications/list` — 生成が worker 専有（#118）。
- `terminal/sessions` — snapshot が worker の 3s sweep で DB に書かれる（#1665）。

## コスト試算モデル（透明なモデル）

目的は「repo top を 1 タブ開きっぱなしのときの RPC ボリューム」のオーダー把握と、
eager 化で削れる量の見積もり。明確な前提を置いた透明なモデルであり、実測値を基にする。

### モデル式

```
RPC数/時/タブ ≒ 定期ポーリング ＋ イベント駆動 refetch
定期ポーリング   ＝ events/list（2,400/時） ＋ worker/status（~60/時） ≒ 2,460/時
イベント駆動     ＝ events/時 × 平均 invalidation 対象 hook 数
```

### 前提（明示）

1. `events/list` はタブ可視の間 1.5s 間隔で poll（`use-loophub-events.ts:12`）。非可視時は停止。
2. イベント 1 件は `event-keys.ts` の mapping により 0〜複数の query key を invalidate し、
   mount 済み query があれば refetch される。
3. repo top では repo スコープのイベントが `queryKeys.issues(repo)` 等を invalidate するため、
   対象 hook 数は 2〜4 本と仮定（repo top に mount される `pageData/issueList` と
   origin/agent 系の数）。
4. イベント量はこの環境の実測レンジ（平均 ~123/時、ピーク ~267/時）を使う。増員シナリオでは、
   人間の回答（thread #21: 稼働数は 2 倍以上に増える）に基づきイベント量 ~2 倍を仮定する。

### シナリオ（レンジ）

| シナリオ | events/時 | イベント駆動 refetch/時（対象 2〜4 本） | 合計 RPC/時/タブ |
| --- | ---: | ---: | ---: |
| アイドル（イベントほぼ無し） | ~0 | ~0 | ~2,460 |
| 平均稼働（実測 5 日平均 ~123/時） | ~123 | ~246〜492 | ~2,710〜2,950 |
| ピーク日（08-08: ~267/時） | ~267 | ~534〜1,068 | ~2,990〜3,530 |
| **増員（稼働 2 倍以上、thread #21 の前提）** | ~246〜534 | ~492〜2,136 | ~2,950〜4,600 |

### eager 化（推奨案 C）による削減見積もり

- 表示 refetch のうち git 由来で削れるのは「head / base の `rev-parse` 2 回/PR + `git status`
  （worktree PR のみ）」。merge-preview / diff-stat は pullShaStatus キャッシュで既に 0 なので、
  eager 化の対象にならない。
- open PR 6 本・平均イベント ~123/時・表示 refetch がその半数程度（対象 2 本に絞った場合）と仮定すると、
  refetch 回数は ~60/時で、rev-parse 2 回/PR × 6 PR ≈ 12 回/refetch がなくなる。
  1 回の rev-parse は数 ms のため、**純粋な計算コストの削減は ~秒/時/タブのオーダー**で限定的。
- 一方、web のリクエストパスから git を取り除くことで、**lh-web の単一 event loop 上の直列化の
  主要ドライバ（`pageData/issueList` の git fan-out）を web プロセスから外す**ことができる。こちらが
  主たる価値。#102 は「`stateForPull` の 5.4 秒も `notifications/list` の 11.8 秒も、その handler が
  重いのではなく、同じ event loop 上で `pageData/issueList` が数秒〜数十秒 CPU と subprocess を
  占有していることの影である」と結論しており（`docs/slow-rpc-root-cause.ja.md:131-132`）、
  eager 化はこの影の発生源を表示経路から取り除く。
- なお前版が書いた「worker の sweep と web の並行 git 操作（git index lock）・SQLite ロック競合の
  回避」という主張は誤りで、ここで取り下げる。#102 は worker の sweep と web の遅延に因果はないと
  結論し（同 doc:134-163）、SQLite は WAL のため writer は reader を止めない（同 doc:165-167）。
  `notifications/list` 11,863ms と pull sweep 11,463ms が「同長」という相関は issue #102 本文の
  生ログにはあるが、同 doc はそれを共通原因（負荷が高い時間帯）によるものと説明しており、
  lock 競合の根拠にはならない。
- 案 B / C（投影テーブル + worker 書き込み）は、jobs テーブル導入（out of scope）を待たず、
  pull_status のような軽いテーブル + pull sweep の 1 行書き込みで実現可能。

### 除外した要素

- `agent_session.usage_updated` が高頻度に invalidate する `pulls/usage` は、git フリーの独立クエリに
  分離済み（#2263）のため本試算の対象外。
- エージェント稼働数は 2 倍以上に増える見込み（thread #21 の回答）で、イベント量・eager 化の削減価値は
  増員シナリオ（上記）で扱う。
- git-cache の廃止（thread #23 の検討）は、判断の方向を変えないことを確認した。廃止時はダイアログ等の
  SHA 入力コマンドの再利用が消えるため、部分 eager の優先度が上がる（該当節に明記）。

## 前提・データソース・計算方法・除外した要素

- すべてのメソッド名・行番号は 2026-08-10 時点の `main`（HEAD `e3775368`）の worktree から取得。
  以後の変更で行番号はずれる。
- `pageData/issueList` の内訳（git 由来 / DB 由来）はコード読解による。実際のプロファイル
  （rev-parse と git status の内訳）は `--debug` の debug panel で確認可能だが、今回は計測していない。
- `lh issue list --json` の 1.5–1.7s は CLI プロセス全体（tsx 起動 + DB + git）であり、ページャ/HTTP
  層を含まない。絶対値ではなく #112 の比（変更前後）と合わせて読むこと。
- 実 DB 数値はこの環境の `~/.loophub/loophub.db` に限る。他環境では行数・流量が異なる。
- 判断の対象外: 棚卸しで「seed」「dead」「mutation」とされたメソッド、DB/config 由来の read 系。
- `pulls/diff` の実測値（81〜164ms、小 2 / 中 45 / 大 192 ファイル）は #140 が参照する枠組み文書
  `docs/worker-event-architecture-design.ja.md:127,162-164` に記録されている。本ドキュメントの lazy
  判断はダイアログ限定・出力大に基づくが、実測値の出所もこの文書で補強できる。
- eager 化の価値の根拠は #102 の調査結果（`docs/slow-rpc-root-cause.ja.md`）に正確に合わせた。
  同 doc の結論「worker の sweep は web の RPC 遅延の原因ではない」「SQLite は WAL のため writer は
  reader を止めない」に従い、前版にあった「SQLite ロック競合」「git index lock 競合」の主張は
  取り下げている（推奨案 C 節とコスト試算節に明記）。
- 本issueで参照されていた `docs/worker-event-architecture-concept.ja.md` と
  `docs/worker-event-architecture-design.ja.md` は**プライマリ checkout
  （`/Users/jugyo/workspace/jugyo/loophub/docs/`、untracked、2026-08-09 作成）に実在する**。
  本調査当初の検索は pr-142 worktree と git の ref に限定しており、これを発見できなかった
  （review 165 で修正）。判断の枠組みは実際にこの 2 文書を参照して反映している。
- eager / lazy の実装、pageData 畳み込みの追加、dead メソッドの削除判断は行わない（#140 のスコープ外）。

## 人間への質問と回答（2026-08-10 の diff feedback / PR comment で確認）

以下はデータからは確定できない前提だったが、人間の回答が得られたものは「解決済み」として記録する。

1. **枠組み文書の扱いと実装ターゲット**
   - ①（untracked 文書をコミットするか）→ **解決済み**: 「この PR で生成したドキュメント以外は
     コミットしない」（thread #20）。本 PR の成果物 `docs/web-rpc-eager-lazy-judgment-2026-08-10.ja.md`
     のみをコミットし、枠組み文書（`worker-event-architecture-concept.ja.md` /
     `worker-event-architecture-design.ja.md`）はプライマリ checkout の untracked のまま残す。
     本レポートの枠組みへの参照は、repo 外の作業用ファイルを前提とした参照である点に注意。
   - ②（watcher / dispatcher / job queue の 5 プロセス構成が実装ターゲットとして確定しているか）→
     **解決済み**: 「確定する」（PR comment #285、P1）。枠組みを実装ターゲットとして確定し、
     表示は lazy（web のリクエストパス計算）を基本に据える。投影テーブル（推奨案 C）と
     `pulls/diff` の部分 eager は枠組み外の追加設計として後続 issue で設計する。
2. **エージェント稼働数の今後の見込み** → **解決済み**: 「稼働数は増える。2 倍以上にはなるのではないか」
   （thread #21）。ドライバ指標とコスト試算に増員シナリオ（イベント量 ~2 倍）を加えた。
   `agent_session.usage_updated`（全体の 66%）は稼働エージェント数に比例するため、eager 化の
   削減価値も比例して増える。
3. **GitHub PR 連携を使う予定があるか** → **解決済み**: 「行う予定がある。eager 化に賛成」（thread #22）。
   `pulls/githubStatus` の判断を「任意」から「**eager 化を実施する**」に確定した。実装は既存の
   github merge sweep（60s、既に `gh` を実行中）への便乗を前提とする。なお現状はこの環境で GitHub
   連携が未使用（`github_pull` 0 件）のため、実コストは導入後に発生する。
4. **git-cache を廃止するか** → **解決済み**: 「廃止してみよう」（PR comment #285、P3）。
   `core/git-cache.ts` を削除する。pull-status-cache は残す。廃止後はダイアログ等の再表示が毎回
   spawn になり、`pulls/diff` の部分 eager（P4）が吸収する。
5. **projection / jobs の導入をどの issue で行うか** → **未回答**。推奨案 C の実装（pull_status テーブル
   or jobs テーブル）は #140 の Out of scope。判断の受け皿となる後続 issue の切り出しは人間の決定。

## 後続 issue の提案（切り出し案・人間が承認後に起票）

以下の 7 件に切り出す。**実施が確定しているのは A〜E**（人間の決定済み）、F / G は任意・優先度低。
推奨実施順序: A → C → B → D を順に、E（枠組み）は別トラックで並行。

| # | issue 案 | 根拠の決定 | 範囲 | 依存 | 規模 |
| --- | --- | --- | --- | --- | --- |
| **A** | git-cache の削除 | P3（廃止） | `core/git-cache.ts` と使用箇所を削除。pull-status-cache（SHA ペア LRU）は残す | なし（独立・小） | S |
| **B** | pageData/issueList の eager 化（案 C） | P2（案 C） | `pull_status` 相当の projection（mergeable_state + diff 集計、(baseSha, headSha) キー）。pull sweep（5s）が `currentMergeableState` の計算結果を書き込み、表示は DB 読み。`working` / `worktree_path` は lazy のまま | なし（独立） | M〜L |
| **C** | pulls/diff の部分 eager | P4（実施） | head 移動時に解決済み base の diff + 行座標（`parsePatchWithCoordinates` 結果）を DB へ投影し、diff ダイアログは DB 読み | A の後が望ましい（A で再表示の spawn が戻る分を吸収） | M |
| **D** | pulls/githubStatus の eager 化 | thread #22（賛成） | github merge sweep（60s）に便乗して表示対象の github_pull ステータスを先行取得。既存の TTL 60s キャッシュ（`github_pull_status`）を延長 | なし（独立）・GitHub 連携導入後が前提 | S |
| **E** | watcher / dispatcher / job queue 構成の実装 | P1（確定） | 枠組み文書（untracked）の 5 プロセス構成。既存 sweep / dispatch / 副作用の再配置。B / C の投影書き込みを watcher へ移す再設計を含みうるが、現在の pull sweep での先行実装を許容 | なし（別トラック・大） | L |
| F | repos/originSync の DB 更新 | —（優先度低） | pull 実行時と merge 時に ahead/behind を DB へ書く。現状の event 駆動 lazy で実用十分 | なし | S |
| G | dead / seed メソッドの扱い | #130 の人間への質問 2 と重複 | 棚卸しの dead 21 件の削除・維持判断 | なし | S |

- A〜D は E とは独立に現在のコードベースで実装できる（E が watcher へ移す際に B / C の書き込み先を
  引き継ぐ設計にする）。
- A は E の「git を job queue へ集約」の第一歩としても整合する。
- 文書（枠組み・本レポート）のコミットは thread #20 の判断どおり、本 PR の成果物のみ。

### 順次 merge しても動作が維持される条件（人間の質問、PR comment #294 への回答）

A〜D は「順番に main へ入れても動作は維持される」**はい**。各ステップの維持条件:

- **A（git-cache 削除）**: キャッシュは性能最適化のみで正確性に寄与しない。削除しても挙動不変
  （毎回 spawn するだけ）。単独で安全。
- **B / C（投影の導入）**: 新テーブルは追加 migration（後方互換）。表示は**「投影があれば読む、
  無ければ live 計算」の fallback**にすることで、テーブル未生成・sweep 未実行・head 移動直後の PR でも
  挙動を維持する。C は特に「投影の (baseSha, headSha) が現在の head と一致するときだけ投影を読み、
  不一致なら live 計算」とする（head 移動直後の diff 開封でも正しい diff を返す）。
  - 鮮度について: 投影読みは pull sweep（5s）の計算結果を使うため最大 5s 古くなりうるが、**現状の
    表示も head 移動 event（pull sweep 検知）が届くまで更新されない**ため、実質同等の cadence。
    厳密な live が要る場面は上記 fallback でカバーする。
- **D（githubStatus eager）**: 既存 TTL 60s キャッシュの先行更新を足すだけの加法変更。安全。
- **E（プロセス再構成）**: これだけは「一発で切り替えて動作維持」が難しい。段階
  （例: まず lh-watcher-git 抽出 → dispatcher → job queue）に切って各段を独立 merge 可能にする設計が
  要る。B / C の投影書き込みを watcher へ移す際も、同じキー・同じ意味（(baseSha, headSha) キー、
  `currentMergeableState` 相当）を引き継ぐため挙動は変わらない。
