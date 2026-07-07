# ワークフロー(Loop)改善の仕組み — Phase 1 設計(取得・保存)

> Status: Design (Phase 1 — retro / decision log の取得・保存) · Issue: #82 · 関連: #74(canon docs)
> 前提となる要求・方針(What/Why)は [`loop-retrospective-prd.ja.md`](./loop-retrospective-prd.ja.md)。
> 本書の対象は **Phase 1 = 振り返りと decision log を生成し「保存」する所まで**。
> 保存した知見の**活用**(lessons 昇格・集約 digest・改善 PR/issue・ルーブリック拡張)は
> **Phase 2** で、本書 §6 に方針のみ・詳細は後続の別設計。

---

## 1. 位置づけと Phase 1 スコープ

PRD が定義した測定目的(north-star + C/Q/I 3 軸)・観点 R1–R8・自動/人間境界を、LoopHub の
既存資産(`events` / `issues` / `pulls` / `agent_sessions` / `emitEvent`)の上に実装する。

**Phase 1 で作るもの**: ①振り返りの生成(観点採点 + 自由記述 findings)②その入力の取得
(イベント・PR・任意で transcript / decision log)③**保存**(retros + decision log)。
状態を変える操作(skill 編集・改善 PR 等)は含まない — それらは Phase 2(§6)。

---

## 2. ルーブリックの観測(HOW)

PRD §4 の各観点を**どう観測するか**。各観点に「LoopHub データだけで安く取れる proxy signal」を
必ず一つ持たせる。transcript 解析が要る観点は MVP では任意とする。

| # | 軸 | 観点 | 安価な proxy(LoopHub データ) | transcript で深掘り |
|---|----|------|------------------------------|---------------------|
| R1 | C | 人間介入の量 | ユーザーターン数、issue.commented 件数 | 介入の種類(方針修正/事実訂正/承認待ち) |
| R2 | C | issue の曖昧さ | 実装中の issue.updated 回数、追加質問コメント | AC の後付け・解釈ブレ箇所 |
| R3 | Q | レビュー往復 | `reviews` の REQUEST_CHANGES 件数 / ready-for-review サイクル数 | 指摘の本質度(瑣末 vs 重大) |
| R4 | Q | レビュー過剰/過少 | diff 行数・ファイル数 × レビュー往復数 | 軽微 PR に過剰往復/重大 PR に素通り |
| R5 | Q | 飛ばしたステップ | PR body に Evidence/Test plan 有無、テスト実行痕跡 | skill 手順のスキップ箇所 |
| R6 | I | エージェントの虚偽 | 「テスト green」主張 vs PR body のテスト実行痕跡・再実行結果、Closes 対象と diff の不一致(注: LoopHub に CI/status checks は無い) | コーディングagの誇張をレビューが見抜けたか |
| R7 | Q | スコープ逸脱 | diff のファイル群 vs issue scope 記述 | 「ついで修正」の混入 |
| R8 | C | 所要時間/手戻り | pull_request.opened → pull_request.merged の経過、merge_conflict 発生有無 | 手戻りの原因 |

各観点の記録形式: `{ id, signal, value, severity: ok|warn|bad, note }`。
数値の絶対閾値は初期は決め打ちせず、相対比較(同種 PR の分布)で warn を出す方針(PRD §3 の
「定量化はしない」に対応)。自由記述の出力形式は `findings[]`:
`{ category, severity, note, evidence_ref, proposed_action? }`。`category` は自由語彙で記録する
(正規化・昇格は Phase 2。§6)。

---

## 3. トリガと入力

### 3.1 トリガ

**Phase 1 が実装するトリガは手動 skill `/lh-retro` のみ**。マージ時に自動で retro を起動する
「受け側」(`pull_request.merged` を購読する dispatch/cron)は **Phase 1 では実装しない**。

| Phase 1 で実装 | 契機 | 備考 |
|----------------|------|------|
| 手動 skill `/lh-retro <pr>` | 人がコマンド実行 | 一次手段。単一 PR 指定 + 直近 merged PR のバックフィル(§5.1) |

**イベント定義(将来の自動トリガが購読する契約)**: マージ時自動起動スライス(§5.2-3 / Phase 2)は
**既存イベント `pull_request.merged`**(LoopHub が merge 時に emit。`core/service.ts`)を購読して
retro を起動する。Phase 1 はこのイベントを **前提・契約として記すだけで購読しない**。新規イベントの
追加は不要 — 既存の `pull_request.merged` をそのまま使う。Phase 1 が *emit* する側のイベント
(`session.retro.created` 等)は §4.2。

**未マージ PR クローズはトリガに採用しない**(コスト対効果が低い)。中止/失敗ループの学びが
要るときは手動 `/lh-retro <pr>` で個別にカバーすれば足り、専用イベント(`pull_request.closed`
新設)や常時監視を入れる価値は薄い。

**手動 skill の位置づけ**: 日常的に毎 PR を人手で振り返ることは想定しない。だが skill として
存在する価値がある — 自動トリガの実装が先になる前提で、それまでの間を手動で繋ぐ。とくに
**「まだ振り返っていない直近 N 件の PR をまとめて後追い振り返りする」バックフィル用途**を
一級のユースケースとする(`/lh-retro` を retro 未実施の merged PR 群へ順に適用)。自動化が
入った後は、取りこぼし救済・任意 PR の再振り返りとして残す。

非同期前提: マージは人間が行うため、(自動化後の)振り返りは**イベント駆動で別プロセス
(dispatch/cron)が拾う**のが自然。元の dev セッション継続には依存しない(セッションは
終了済みでよい)。当面はこの非同期実行を手動 skill が担う。

### 3.2 入力

振り返りは「LoopHub の客観タイムライン」と「セッションの主観経過」を突き合わせる。

| 入力 | 取得元 | 用途 |
|------|--------|------|
| イベント履歴 | `lh events --repo o/n`(issue.* / pull_request.* / review系) | ループの客観タイムライン・R1/R3/R8 |
| PR diff | `lh pr diff` | 規模・スコープ R4/R7 |
| レビュー履歴 | `reviews` / `review_comments`(`lh pr view`) | R3/R6 指摘内容 |
| issue 本体 | `lh issue view`(本文・AC・scope) | R2/R7 の基準 |
| コメント | `comments` | R1/R2 介入痕跡 |
| **セッション transcript** | **cc-session-finder MCP**(ローカル索引、read-only)で `session_id` から引く。PR→session の紐付けは LoopHub が持つ(§4.3) | R1/R5/R6 の深掘り。MVP では任意 |
| **decision log** | transcript から passive 抽出した根拠(§4.3) | R2/R6/R7 の WHY |
| 既存 retro | 蓄積済み retros(§4) | 再振り返りの重複検出・バックフィル判定 |

transcript は本来エージェント実行環境にある。**cc-session-finder があればそれ経由で
後追い参照する**(LoopHub に抱え込まない)。索引が無い環境向けには LoopHub へ保存する
フォールバックを任意で用意する(§4.3.2)。いずれにせよ **MVP は LoopHub のイベント/PR
データのみで回し、transcript 取り込みは後続スライス**(§5.2)。

---

## 4. 知見の取得・保存

Phase 1 の主眼。生成した retro(観点 + 自由記述)と decision log を**確実に貯める**。

### 4.1 蓄積先の選択肢

| 案 | 長所 | 短所 |
|----|------|------|
| A. LoopHub DB 新テーブル + events | 構造化・集計・UI 表示・イベント連携 | 人間が直接読みにくい、スキーマ管理 |
| B. Markdown ナレッジ(git 管理) | 人間可読・PR でレビュー可・履歴・移植性 | 集計/横断クエリが弱い |
| C. Claude memory(`~/.claude/.../memory`) | エージェントが次回自動参照 | プロジェクト横断で散逸・機械集計に不向き |

### 4.2 推奨: 生 retro は DB(`retros`)へ保存

Phase 1 は **生の振り返りを構造化して貯める**ことに集中する:

- **生の retro(構造化・機械処理向け)→ LoopHub DB `retros` + events**(本流)。
  後の集約・再発検出・UI 表示の基盤になる。
- MVP では DB を立てる前に **Markdown 1 ファイル(案 B)で代替保存**してもよい(§5.1)。
  どちらも「貯める」目的は同じで、DB 化は Phase 1 内の後続スライス(§5.2)。
- **確定知見の Markdown playbook(`docs/lessons/`)と memory への昇格は Phase 2**(§6)。
  Phase 1 は生 retro の保存までで、人手でキュレーションされた lessons は作らない。

`retros` スキーマ案(`agent_sessions` と並列、`core/db.ts` のスタイルに合わせる):

```sql
CREATE TABLE retros (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id      INTEGER REFERENCES repos(id),
  issue_id     INTEGER REFERENCES issues(id),   -- 振り返り対象 issue
  pr_id        INTEGER REFERENCES issues(id),    -- 対象 PR(issues 統合テーブル)
  session_id   TEXT    REFERENCES agent_sessions(id),  -- 実装セッション(判れば)
  rubric_json  TEXT,   -- R1..Rn の {signal,value,severity,note}[]
  findings_json TEXT,  -- 自由記述 {category,severity,note,evidence_ref,proposed_action?}[]
  status       TEXT NOT NULL DEFAULT 'draft',    -- draft|reviewed|applied|dismissed(reviewed 以降は Phase 2)
  reviewed_by  TEXT,
  redacted     INTEGER NOT NULL DEFAULT 0,        -- findings_json/rubric note に redaction 適用済みか
  redact_ruleset TEXT,                            -- 適用した redaction ルール版(後で強化したとき再処理対象を識別。session_artifacts と対称)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
```

`retros` は UI 表示される常時オンの本流(§4.3.3)なので、`session_artifacts` と同じく
`redacted` / `redact_ruleset` を持たせ、redaction 強化時に弱いルールで保存済みの行を
特定・再処理できるようにする(§4.3.3 末尾)。再処理の対象は **保持中の retros 行**(生
transcript artifact の TTL とは別ライフサイクル。§4.3.2 で整理)。

新イベント型(既存 `events` テーブル・`emitEvent` をそのまま利用)。Phase 1 は生成・保存系のみ:
`session.retro.created`(+ Phase 2 で `retro.reviewed` / `retro.finding.promoted` /
`improvement.proposed` を追加)。

### 4.3 decision log の取得・保存(根拠の WHY)

retro の質は「セッションで実際に何が起き、**なぜそうしたか**」をどれだけ手元に残せるかで決まる。
本節の **decision log** はその WHY の蓄積を指す。原則は **実装セッションに極力負荷をかけない**こと。
セッション本文へのアクセスは **既製の索引(cc-session-finder)があればそれを使い**、LoopHub 側で
transcript を抱え込まない方針とする。decision log は次の三層:

#### 4.3.1 セッションの特定とアクセス

- **PR → 実装セッションの紐付け**: セッションは `agent_sessions.kind='dev'` の行として登録され、
  PR との関係は `session_links` に記録される。`lh build` が PR を開く / 再入する際に、起動する
  実装セッションを linked PR へ帰属させる(#316 で `pulls.session_id` は廃止)。したがって経路は
  **PR → `primaryDevSessionForPull`** で完結し、`linked_issue_id` は retro が記録する issue 番号に
  のみ使う。**session 帰属の無い PR では session を特定できず**、その場合 `retros.session_id` は
  NULL のまま(§4.2 の「判れば」)で、retro はイベント/PR データのみで成立させる。
- **本文アクセスは cc-session-finder 優先**: セッション本文(transcript)は LoopHub に
  コピーせず、利用可能なら **cc-session-finder MCP**(ローカル索引、read-only)で session_id
  から引く。retro は別セッション・後追い(`pull_request.merged` 後)で実行されるが、
  cc-session-finder がローカルに索引を持つ限り過去セッションを参照できる。
- **vendor 中立**: cc-session-finder は Claude Code / Codex 双方を索引するため、host 差は
  そこで吸収される。

#### 4.3.2 (任意)フォールバック: LoopHub への保存

cc-session-finder が無い環境(別ホスト、索引未導入、ローテートで消失)向けの **任意の保険**。
一次手段ではないので、必要になったときだけ実装する。

- `SessionEnd` hook(または skill 末尾の 1 回コマンド)で、終了セッションの transcript を
  PR 紐付けで保存する。ホットパス(`issues`/`events`)を汚さないよう専用テーブル + 圧縮 blob:

```sql
CREATE TABLE session_artifacts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id     INTEGER REFERENCES repos(id),
  issue_id    INTEGER REFERENCES issues(id),    -- 対象 PR(kind=pull)/ issue
  session_id  TEXT REFERENCES agent_sessions(id),
  host        TEXT NOT NULL,                     -- 'claude-code' | 'codex' | ...
  format      TEXT NOT NULL,                     -- 'jsonl' | 'normalized'
  content_gz  BLOB,                              -- gzip 圧縮した transcript 本体
  storage     TEXT NOT NULL DEFAULT 'inline',    -- 'inline'(DB blob)| 'file'(外部参照)
  file_path   TEXT,                              -- storage='file' のとき $LOOPHUB_HOME/artifacts/<id>.jsonl.gz
  byte_size   INTEGER,                           -- 展開後サイズ
  redacted    INTEGER NOT NULL DEFAULT 0,        -- redaction 適用済みか
  redact_ruleset TEXT,                           -- 適用した redaction ルールの版(後で強化したとき再処理対象を識別)
  captured_at TEXT NOT NULL
);
```

- **DB 肥大対策**: 閾値(例 1 MB)未満は `storage='inline'`、超過は `storage='file'` で
  `$LOOPHUB_HOME/artifacts/` に gzip 保存し DB はパスのみ。CLI は
  `lh session capture` / `lh session artifact <pr>`、emit は `session.artifact.captured`。
- **ファイル権限**: 外部ファイルは LoopHub ユーザ所有で `artifacts/` を `0700`、ファイルを
  `0600`(SQLite DB と同等の保護)。
- **保持/削除ポリシー**: transcript は無期限に貯めない。二段で縛る:
  (1) retro が `reviewed`/`applied`/`dismissed` のいずれかに遷移したら artifact(DB 行 +
  外部ファイル)を purge する(`dismissed` も含める — 放置・未採用こそ最悪の at-rest 露出)。
  (2) status と独立した **最大保持 TTL**(例 N 日)を設け、retro が draft で停滞しても TTL
  到達で必ず purge する(status 遷移に依存しない backstop)。`lh session artifact rm <pr>` で
  行と外部ファイルの双方を即時削除できるようにする。
  この (1)(2) の保持上限は **生 transcript を持つ `session_artifacts` が対象**。`retros` の
  自由記述は §4.3.3 の構造的ドロップで生本文を含まない抽出済みの知見プロダクトなので、
  artifact とは別ライフサイクルで保持し(retro 自体の `status` に従う)、§4.2 の
  `redact_ruleset` 再処理はこの保持中の行に適用する。retros 本文も無期限ではなく、
  `dismissed` 化や用済みで不要になった行は purge 対象とする。さらに artifact TTL と対称に、
  **status と独立した backstop**(例: `draft` のまま N 日を超えた retros 本文は再 redaction か
  purge)を設け、構造的ドロップを抜けた best-effort redaction の取りこぼしが未レビューの
  draft に滞留し続けないよう、at-rest 露出に時間上限を与える。

#### 4.3.3 機密対応(redaction)

transcript は tool 出力にファイル内容・トークン・絶対パスを含みうる。**redaction は
パターン denylist では取りこぼす(非標準形式の鍵・PEM/base64 塊・貼り付けられたファイル
内容・PII・内部ホスト名)前提で best-effort**。可能なら denylist より **構造的に落とす**
(生の tool 出力本文は捨て、要約だけ残す)方を優先し、保存済み artifact は `redacted` 値に
かかわらず機密扱いとする(UI で生本文を既定表示せず、明示操作の後ろに置く)。

- **`retros` テーブル(常時・UI 表示される本流)**: cc-session-finder 経由でも、retro が
  抽出した自由記述を `retros.findings_json` / rubric note に書き、Web UI がそれを表示する。
  この経路では**構造的ドロップを必須**とする(本節冒頭の「推奨」を retros 経路に限り
  「必須」へ格上げ): **生の tool 出力本文・transcript 本文を、findings を生成する LLM
  プロンプトへ入れない**。retro へ渡すのは構造化シグナル(イベント要約・件数・参照 ID)と
  限定引用のみとし、引用も verbatim 再出力を禁じる指示を添える。理由は denylist redaction
  だけに頼れないため: LLM は要約中にシークレットを言い換え・部分再現でき、その変形は denylist
  に当たらない。保存前 redaction は二重防御として依然通す(常時オンの経路を素通しにしない)が、
  **一次防御は「機密を LLM 文脈へ持ち込まない」構造的ドロップ**。
  さらに `retros.findings_json` / rubric note は **at-rest で機密扱い**とし(redaction は
  best-effort のため)、`redacted` / `redact_ruleset`(§4.2)で版を記録、redaction 強化時の
  再処理対象を識別できるようにする。
- **cc-session-finder 経由(一次)**: 本文は LoopHub に残らず索引側に留まるので、transcript
  自体の永続露出は増えない(露出面は上記 `retros` への抽出物に集約される)。
- **フォールバック保存(§4.3.2)を使う場合**: 保存前に redaction パス(API キー/トークン様
  文字列・`env` ダンプ・credential 中身のマスク)を通し `redacted=1`・`redact_ruleset` を
  立て、取得経路を `issues`/`events` と分ける。

#### 4.3.4 根拠の抽出/記録(passive)

働くセッションへの負荷を最小化する:

- **passive(既定)**: retro(別セッション)が cc-session-finder 経由で transcript を読み、
  「X にした、理由は Y」を抽出 → `retros.findings_json` / rubric の根拠に使う。**実装
  セッションへの追加負荷ゼロ**、かつその場の発言を読むので事後正当化バイアスが無い。

かつては active 記録(`lh build note` → `dev.note` イベント)も併設していたが、実質使われず
#607 で機構ごと削除した。根拠の取得は passive 抽出に一本化する。

---

## 5. MVP スコープと Phase 1 内の後続分割

### 5.1 MVP(最小で「振り返り → 保存」を一周させる)

- **`/lh-retro <pr>` skill(手動起動)** 1 本のみ。
- 入力: `lh events` + `lh pr diff` + `lh pr view`(reviews) + `lh issue view`。transcript は使わない。
- ルーブリック: R1/R3/R5/R8 の小セット + 自由記述 findings。
- 出力: `docs/retros/` に **Markdown 1 ファイル**を生成し、git で蓄積(DB を立てる前の暫定保存)。
- **バックフィル対応**: 単一 PR 指定に加え、`/lh-retro`(引数なし or 範囲指定)で
  **retro 未実施の直近 merged PR 群を順に振り返る**モードを持たせる(自動トリガが入るまでの
  当面の運用手段。§3.1)。retro 済みかは出力 Markdown(または後の `retros` 行)の有無で判定。
- 集約・自動提案・lessons 昇格・自動トリガは含めない(Phase 2 / 後続)。

これだけで「マージ後に振り返り、知見を貯める」最小ループが、手動および直近 PR の
バックフィルで回る。**活用しなくても「貯まっている」こと自体が価値**(後で読める・監査できる)。

### 5.2 Phase 1 内の後続スライス

1. **retro skill + Markdown 蓄積(MVP)** — §5.1。最初に実装。
2. **retros DB テーブル + events + `lh retro` CLI + Web UI 表示** — §4.2。構造化・集計の保存基盤。
3. **マージ時自動トリガ(受け側の実装)** — §3.1 のイベント契約 `pull_request.merged` を
   dispatch/cron で購読し retro を自動生成。優先度は低め(コスト/運用負荷の都合で後回し)。
   それまでは MVP の手動バックフィル(§5.1)で代替する。
4. **transcript 参照 + decision 抽出(cc-session-finder)** — PR→session 紐付け(§4.3.1)を辿り、
   retro が cc-session-finder 経由で本文を読み R1/R5/R6 を深掘り、passive に WHY を抽出
   (§4.3.1/4.3.3/4.3.4)。一次手段。
5. **(任意)LoopHub 保存フォールバック** — cc-session-finder が無い環境向けに `SessionEnd`
   hook + `session_artifacts` + redaction(§4.3.2)。必要になったときだけ。

(旧 6 の active decision log — `lh build note` / `dev.note` — は実質使われず #607 で削除。)

依存順: 1 →(2 と 3 は並行可)→ 4 →(5 は任意)。4 は cc-session-finder があれば保存実装
(5)抜きで成立する。1 だけでも価値が出る縦切りにしてある。

---

## 6. Phase 2(後続・別設計)— 知見の活用(方針のみ)

Phase 1 で貯めた retros / decision log を**改善へ還元する**フェーズ。詳細設計は Phase 2 の別
doc/issue とし、ここでは Phase 1 が用意しておくべき接続点だけを記す(方針は PRD §6):

- **lessons 昇格**: findings をクラスタ正規化し、再発カテゴリ(例: 3 セッション以上)を
  `docs/lessons/`(人間可読 playbook)へ昇格。`retro.finding.promoted` を emit。
- **集約 digest**: `/lh-retro-digest`(cron か N 件蓄積で起動)が status=`reviewed` の retros を
  読み、上位摩擦に「改善提案ドラフト」を生成 → `improvement.proposed`。
- **改善の還元**: skill/プロンプト改善 PR・改善 issue 自動起票・canon 追記(PRD §6 b–d)。
- **ルーブリック自己拡張**: 昇格 finding を新観点 R(n+1) として追加。
- **還流時の prompt-injection 対策**: 還流テキストを untrusted data として扱う(PRD §7 の要求)。

Phase 1 側の備え: `retros.status`(draft|reviewed|applied|dismissed)・`redacted`/`redact_ruleset`・
Phase 2 用イベント型の余地を、§4.2 のスキーマに織り込み済み。
