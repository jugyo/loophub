# issue assignee（`@lh-build`）の廃止 — 設計判断

> Status: Decision（方針確定・実装は別 issue） · Issue: #180 · PR: #181
> 本書は「issue の assignee（`assignee_session_id` / UI の `@lh-build` 表示）を**仕組みごと廃止する**」
> という方針と、その移行計画を記録する。実装そのものは本 issue のスコープ外。

---

## 1. 背景・動機

issue 一覧・詳細に、紐づく dev session を `@lh-build` のような assignee として表示している。
しかし今や `lh build <issue>` するとすぐに **draft PR** が作られ、issue 詳細にも `linked PR #181`
が出るため、「その issue が誰かに着手されている」ことは PR を見れば実質わかる。

→ assignee の表示・仕組みは draft PR と冗長になったのではないか、という再検討。

**決定: Option 2 — 仕組みごと廃止する。** 表示だけ落とす案（Option 1）ではなく、
`assignee_session_id` が担う機能（二重起動ガード・session 解決）を PR ベースの代替へ移し、
列・assign/unassign 経路ごと撤去する。

> 注意: assignee は**表示専用ではない**。安易に列だけ消すと二重 `lh build` ガードと
> `lh resume` / retro の session 解決が回帰する。本書はその代替を先に定義した上で撤去する。

### 1.1 案の比較（なぜ Option 1 ではなく Option 2 か）

| 観点 | Option 1: 表示だけ落とす | Option 2: 仕組みごと廃止（採用） |
|------|--------------------------|-----------------------------------|
| 工数 | 小（描画 2〜3 箇所） | 中〜大（代替の DB 制約 + session 帰属移設 + 撤去 + マイグレーション） |
| 回帰リスク | 小（ガード・session 解決は無傷） | 中（移設順序を誤ると `lh resume`/retro が回帰）。§5 の順序と §6 で管理 |
| issue の動機解消 | 達成（`@lh-build` 表示は消える） | 達成 |
| 残る負債 | **`assignee_session_id` 列と assign/unassign/409 経路が死蔵気味に残る**。draft PR で着手判定する設計に対し、二重管理の状態源が残り続ける | 状態源が PR に一本化され、二重管理が消える |

**Option 1 の利点は明確**: 機能（二重起動ガード・session 解決）を温存するため回帰リスクが小さく、工数も小さい（issue の指摘どおり「仕組みは残るので機能リスクは小さい」）。

**それでも Option 2 を採る理由**:

- issue の本質は「**draft PR が着手シグナルになった今、assignee という別系統の状態源は要るのか**」という問い。Option 1 は表示だけ消して**状態源（`assignee_session_id`）と assign/unassign 経路を温存する**ため、二重管理という根の問題が残る。draft PR を正にする設計判断と整合しない。
- 温存される列・経路（assign/unassign/409・Web エンドポイント）は表示が消えると**使われ方が見えにくい死蔵コード**になりやすく、将来の変更時に「なぜこの制約があるのか」を毎回掘り直す保守コストを生む。
- Option 2 の回帰リスクは「移設前に列を消す」ことに起因するが、これは §5 の順序厳守（代替を入れてから撤去）で構造的に避けられる。リスクは**避けられる種類**であり、Option 1 が残す負債は**残り続ける種類**。

したがって、短期コストは Option 1 が小さいが、設計の一貫性（状態源を PR に一本化）と長期保守性を優先して Option 2 を採用する。逆に、§3.1/§3.2 の代替が想定より重いと判明した場合は Option 1 へ縮退する選択肢も妥当（その場合も本書の分析はそのまま使える）。

---

## 2. 現状の assignee の役割（撤去前の事実）

`assignee_session_id` は表示に加えて 2 つの load-bearing な機能を担う。

| 役割 | 場所 | 何をしているか |
|------|------|----------------|
| スキーマ | `core/db.ts:289` | `issues.assignee_session_id TEXT REFERENCES agent_sessions(id)` |
| 一意制約 | `core/db.ts:292` | `CREATE UNIQUE INDEX idx_issues_assignee_session ON issues(assignee_session_id) WHERE … IS NOT NULL`（**1 session ↔ 1 issue**） |
| 二重起動ガード | `core/store.ts:597-614` | `assignIssueToSession`。issue が別 session に assigned 済み→`CONFLICT_ASSIGNED`、session が別 issue に assigned 済み→`CONFLICT_SESSION`。app チェック + 部分 UNIQUE index の二重 |
| 409 ガード | `core/service.ts:407-434` | 上記を `409 Issue assignee conflict` として返す |
| session 解決 | `core/service.ts:903-906` | PR 表示/`lh resume`: `prRow.assignee_session_id ?? linkedIssue?.assignee_session_id` |
| session 解決(retro) | `core/service.ts:1087` | `linkedIssue?.assignee_session_id` を impl session として記録 |
| unassign | `core/store.ts:618-626` | `assignee_session_id = NULL` |
| 表示(CLI) | `cli/index.ts:748` ほか `805` | issue list で `@<agent>`、`issue assign` の確認出力 |
| 表示(serialize) | `core/serialize.ts:106` | `issueJSON.assignee = assigneeJSON(row.assignee_session_id)` |
| assign 呼び出し | `cli/index.ts:535`（`lh build`） / `cli/index.ts:803`（`lh issue assign`） / `web/server/contract.ts:220`（Web API） | assignee をセットする 3 経路 |

**確認した非自明な事実:**

- `lh build <issue>` は assign（`cli/index.ts:535`）→ openPr（`cli/index.ts:554`）を claude 起動前に
  **同期**で連続実行する。draft PR は着手とほぼ同時に存在し、PR 無しの窓は通常フローでほぼゼロ。
- `createPull`（`core/store.ts:245`）は PR 行の `assignee_session_id` を**セットしない**。
  つまり `lh build <issue>` フローの session 解決は **PR → `linkedIssue.assignee_session_id`** に
  完全依存している（PR 自身の assignee は `lh build <pr>` で直接動かした場合のみ立つ）。
- 二重起動ガードのアトミック性は **assign ステップ**が担保する。draft PR の冪等チェック
  （`openPullLinkedToIssue`, `core/store.ts:262`）は soft で、競合する 2 本が両方通過し得る。

---

## 3. 各検討ポイントへの移行方針

廃止しても回帰しないために、撤去の**前提**として以下を用意する。

### 3.1 二重 `lh build` ガード → open-PR 単位の hard 制約

assign が消えると、唯一のアトミックな「この issue は着手済み」判定が無くなる。代替として
**「1 つの linked issue に対して open な PR は最大 1 本」**を DB レベルで保証する。

- `pulls.linked_issue_id` に対し、open（`state='open' AND merged=0`）の行が複数できないよう
  部分一意制約を導入する（例: 生成列 + partial unique index、または書き込み時のトランザクション内チェック）。
- `dev.openPr`（`core/service.ts:739-767`）を、`openPullLinkedToIssue` の soft チェックから
  この制約に基づく挿入へ変更し、競合時は既存 PR を返す（idempotent）か 409 を返す。
- これにより「二重 `lh build` を弾く」根拠が assignee の UNIQUE index から **open-PR 制約**へ移る。

> 残課題: assign は claude 起動の**前**に着手を確定できたが、PR ベースだと openPr 失敗時に
> 着手記録が残らない。§3.3 で扱う。

> **実装時の変更（#186 / PR #187）**: hard な DB 制約（部分一意制約）は採らず、**ソフトチェック**で実装した。
> `dev.openPr` は既存 open PR を返す冪等チェック、`resolveLinkedIssueId` は2本目の open PR を 422 で拒否し、
> 同一ホストの二重 `lh build` は dev ロックが弾く。理由: 将来「1 つの issue に複数エージェントが
> プロポーザル PR を出す」運用の余地を残すため、「1 issue : 1 open PR」をスキーマに焼かない。hard 制約は
> マルチプロポーザル化のとき migration で剥がす羽目になり、最も戻しにくい所に invariant を埋めてしまう。
> ソフトチェックは将来この振る舞いを緩めるのが容易（マルチプロポーザル自体は読み取り側の再設計を伴う別 issue）。

### 3.2 session 解決（`lh resume` / retro）→ PR 行への帰属移設

現状 `lh build <issue>` は PR 行の assignee を立てないため、session 解決は issue の assignee に依存する。
撤去後も辿れるよう、**session 帰属を PR 行へ移設**する。

- `dev.openPr` で PR を作る際、その PR（`issues` の kind='pull' 行）に session を帰属させる
  （`createPull` を session 受け取りに拡張、または PR 作成直後に帰属をセット）。
- `core/service.ts:903-906` / `1087` の解決を `prRow` 側の帰属だけで完結させ、
  `linkedIssue?.assignee_session_id` への fallback を除去する。
- 帰属の格納先は assignee 列の撤去に合わせて再設計する（PR 専用の session 列、または
  `dev.openPr` が発火する event に session を含めて events から辿る等。retro 設計
  [`loop-retrospective-design.ja.md`](./loop-retrospective-design.ja.md) の PR→session 経路と整合させる）。

### 3.3 PR を作らない / PR 作成前に失敗した dev session

assignee が唯一情報を持っていた局面。撤去後は次のいずれかで扱う:

- `lh build` は openPr まで同期で進むため、PR 作成前に死ぬのは異常系（git/worktree 失敗等）。
  この window は **session/health 表示**（`agent_sessions`）で扱い、assignee バッジでは表さない。
- openPr を着手の確定点とし、それ以前の失敗は「未着手」として扱う（PR 無し = 未着手）。
  PR ベースは「PR 無し＝未着手」で自己クリーニングされ、stale な assigned 状態を残さない利点がある。

### 3.4 表示の撤去

- `cli/index.ts:748` の `@<agent>` 表示、および `core/serialize.ts:106` の `issueJSON.assignee` を撤去。
- Web 側の assignee 表示・`web/server/contract.ts:220` の assign エンドポイントを撤去。
- issue の着手シグナルは linked PR の表示に一本化する。

---

## 4. 撤去対象（実装 issue 向けチェックリスト）

§3 の代替を入れた**後**に撤去する。

- [ ] `lh issue assign` コマンド（`cli/index.ts:803`）と Web assign エンドポイント（`web/server/contract.ts:220`）
- [ ] `assignIssueToSession` / unassign / `assigneeJSON`（`core/store.ts:597-643`）
- [ ] assign / 409 ガード（`core/service.ts:407-434`）
- [ ] session 解決の `linkedIssue.assignee_session_id` fallback（`core/service.ts:903-906, 1087`）→ §3.2 へ移設
- [ ] 表示（`cli/index.ts:748`, `core/serialize.ts:106`, Web）
- [ ] `lh build` の assign 呼び出し（`cli/index.ts:535`）
- [ ] スキーマ: `issues.assignee_session_id` 列と一意 index（`core/db.ts:289, 292`）— 後方互換のためマイグレーションで対応

## 5. 移行ステップ（順序）

1. **代替を入れる**: open-PR 単位 hard 制約（§3.1）＋ PR 行への session 帰属移設（§3.2）。
2. **解決を切替**: `lh resume` / retro の session 解決を PR 帰属だけで完結させる。
3. **表示を撤去**: CLI / serialize / Web から assignee を削除（§3.4）。
4. **assign 経路を撤去**: `lh build` / `lh issue assign` / Web エンドポイント。
5. **スキーマ撤去**: 列・index をマイグレーションで除去。

各ステップ単独で green を保ち、2 を終えるまでは 3〜5 に進まない（session 解決の回帰を防ぐ）。

## 6. リスク

- **session 解決の回帰**: 移設（§3.2）前に列を消すと `lh resume` / retro が壊れる。順序厳守。
- **二重起動の取りこぼし**: open-PR 制約がアトミックでないと競合 2 本を許す。DB 制約で保証する。
- **互換**: 既存 DB の `assignee_session_id` を参照する箇所が残らないよう、撤去はマイグレーションと
  同 PR で行う。

---

## 7. 結論

issue assignee（`@lh-build`）は draft PR と冗長になったため、**仕組みごと廃止**する。ただし
二重起動ガードと session 解決は load-bearing なので、それぞれ **open-PR 単位の hard 制約** と
**PR 行への session 帰属移設** へ置き換えてから撤去する。本書はその方針確定であり、
実装は §5 の順序に沿って別 issue で行う。
