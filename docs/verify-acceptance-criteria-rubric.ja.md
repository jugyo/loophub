# Verify を acceptance criteria の rubric 採点にする設計

> Status: Design（実装なし）· Issue: #1878 · 前提: [`docs/workflow.ja.md`](./workflow.ja.md)
> （Execute / Verify 契約と Verify の独立検証・head SHA pin レビュー）
>
> 着想元: Anthropic ブログ "Building verification loops in Claude Code with skills"
> （rubric / grading agent の考え方）。本書は Verify step が issue の acceptance criteria（以下 AC）を
> **1 項目ずつ pass/fail で採点（grade）し、その per-criterion 結果を fact としてドメイン状態へ残す**方式を
> 設計する。実装（コード・スキーマ migration・UI 実装）は本書のスコープ外で、後続の実装 issue（§10）に委ねる。
>
> **設計方針（supervisor 判断による確定）**: AC は issue body の `## Acceptance criteria` markdown を
> パースするのではなく、**安定した criterion ID を持つ専用の構造化データ**として保持する。markdown の
> AC セクションを rubric の source にはしない。詳細は §3。この判断は issue #1878 の当初の AC #1
> （「body のどこをパースするか」）を上書きし、スコープを issue 作成/編集・serialize・UI へ拡張する（§2・§10）。

---

## 1. 背景と解決すべき問題

現状の Verify は、3 ポインタ（issue 参照, base SHA, head SHA）が指す固定 diff に対して、自由記述の
findings と単一 verdict（`pass` / `request_changes`）を返す。verdict は `reviews` 行の `event` 列に保存され、
head SHA に pin される（[`core/service/reviews.ts:79-99`](../core/service/reviews.ts)、
[`core/db.ts:195-205`](../core/db.ts)）。Verify agent は issue を自分で読み（`lh issue view`）、AC を
**自然言語で holistic に**判断しているが、その判断は issue の AC 各項目と**構造的に紐づいていない**
（[`core/workflow/contracts/verify.ja.md:3-7`](../core/workflow/contracts/verify.ja.md)）。

その結果、次が観測できない。

- どの AC 項目が満たされ、どれが未達で `request_changes` になったのか。
- 再検証（head 前進後の fresh Verify）で、どの項目が新たに pass/fail に転じたのか。
- run 全体で「AC の何割が検証済みか」という進捗。

LoopHub の既存の強みである「検証可能な acceptance criteria」を Verify 側へ接続し、AC を rubric として
per-criterion に採点・記録したい。ただし、既存の Execute / Verify 契約、Verify の独立性
（[`docs/workflow.ja.md:229-241`](./workflow.ja.md)）、および fire-and-forget / 可視エラー方針
（[`CLAUDE.md` の設計原則](../CLAUDE.md)）を壊さない載せ方が要る。

### なぜ markdown パースではなく専用データ構造か

AC を「issue body の `## Acceptance criteria` チェックボックスをパースして得る」方式は identity が
**位置（document order の index）依存**になり、次の不安定さを構造的に抱える。

- AC を編集・並べ替えると index がずれ、過去の採点結果が別 criterion に対応してしまう。
- 継続行・コードブロックをまたぐ multi-line criterion の切り出しが曖昧。
- ネスト・非チェックボックス（散文）の AC を安定に拾えない。

Linear / GitHub / Jira など成熟した issue tracker は、この不安定さゆえに**追跡単位を「本文テキストの位置」
ではなく「安定 ID を持つ構造化 entity」に置く**（Linear の sub-issue、GitHub が task list パースから
移行した sub-issues、Jira の checklist アイテム）。本設計もこの学習に従い、criterion を **ID を持つ
構造化データ**として保持し、テキストはそこから得る。

### 確定している不変条件（設計の制約）

調査で確認した、設計判断の土台となる既存の不変条件。

1. **review 行が verdict の唯一の真実源。** 提出時に emit される `pull_request.review_submitted` /
   `workflow_run.review_submitted` は観測トリガーに過ぎず、payload は `review_id` を運ぶだけで verdict
   本体を含まない（[`core/service/reviews.ts:108-127`](../core/service/reviews.ts)）。
2. **freshness は review の `head_sha` pin と current HEAD の比較だけで導出する。** Verify は launch された
   head を `--commit` で明示 pin し、HEAD が進むと `reviewGate`
   （[`core/store/reviews.ts:133-140`](../core/store/reviews.ts)）と `verification_status`
   （[`core/service/workflow-runs.ts:804-814`](../core/service/workflow-runs.ts)）が stale と判定する。
   Workflow 専用の freshness / checkpoint 状態は追加しない（[`docs/workflow.ja.md:273-277`](./workflow.ja.md)）。
3. **issue body は verbatim な markdown で保存され、構造化 AC の概念は今は無い。** issue body は
   `core/service/issues.ts` がそのまま格納し、`## Acceptance criteria` を項目単位で解釈するコードも、
   sub-issue / checklist のような子 entity も存在しない。本設計はこの「構造化 AC」を新規に導入する。
4. **review の子ファクトを review 行に紐づけて保存する前例がある。** line comment は
   `review_comments(review_id → reviews(id))` として review の子テーブルに置かれている
   （[`core/db.ts:207-217`](../core/db.ts)）。grade も同型の子ファクトに載せる。
5. **Verify は既に issue を読むが PR body・実装者説明は読まない。** 独立性の境界は「issue + 固定 diff のみ」
   であり、構造化 AC を issue の一部として届ければ独立性を壊さない
   （[`core/workflow/contracts/verify.ja.md:9-13`](../core/workflow/contracts/verify.ja.md)）。

---

## 2. 目標と非目標

### Goals

- criterion ごとに**安定 ID** を持つ **専用の構造化 AC データ**を issue に導入する。
- AC 各項目を Verify が **per-criterion に pass/fail 採点（grade）** する契約を定義する。
- grade を、criterion ID への FK で既存の head SHA pin レビューに整合する形で **fact として記録**する。
- 構造化 AC を **issue 作成時に入力**でき、作成後も `lh issue ac add` 等の CLI で**追加・編集**できる
  authoring 経路を定義する（authoring は CLI のみ。Web UI からは操作しない）。
- 構造化 AC を **Verify に issue の一部として届け**、Verify の独立性（fresh session・PR body 非読・固定 diff）を
  維持する。
- 現行の単一 verdict と自由記述 findings を**壊さず共存**させ、集計規則を定義する。
- 構造化 AC を持たない issue の**フォールバック挙動**を定義する。
- Web の issue 表示・run 表示に AC と per-criterion grade を **read-only で見せる**方向性を示す。
- 上記の **実装分割案**を提示する。

### Non-goals

- 実装（コード変更・スキーマ migration・CLI/UI 実装）。本書は設計判断のみ。
- **issue body の `## Acceptance criteria` markdown をパースする方式**。本設計は採用しない（§3）。
  既存 issue の markdown AC を構造化 AC へ移行（backfill）することもしない — 構造化 AC を持たない issue は
  holistic にフォールバックする（§7）。
- issue body 全体を構造化ドキュメント（Linear の ProseMirror 相当）へ移行すること。AC だけを構造化する。
- AC が無いことをエラーにする・issue 作成時に AC を必須化するバリデーション。構造化 AC は任意（§7）。
- **Web UI からの AC 操作（追加・編集・enable/disable・並べ替え）。** authoring は CLI（issue 作成時入力 +
  `lh issue ac add|disable|enable|list` 等）のみで提供し、Web UI は AC を read-only 表示するだけとする（§3・§8）。
- Execute step の契約変更。
- AC を merge gate 化すること。merge 判断は従来どおり人間（[`docs/workflow.ja.md:112`](./workflow.ja.md)）。

> **スコープの明記**: issue #1878 は AC #1 を「body をパース」と枠付けし、「issue 作成時の AC フォーマット
> 追加」を out-of-scope にしていた。本設計はその線を supervisor 判断で越え、issue 作成/編集フロー・
> serialize・UI（read-only 表示のみ）へ踏み込む。AC の編集は CLI のみで、Web UI からは操作しない。
> 実装は §10 の分割で段階化する。

---

## 3. 構造化 AC データと authoring（AC #1 の再導出）

### データ構造

criterion を安定 ID 付きの子 entity として保持する新テーブルを導入する。

```sql
CREATE TABLE IF NOT EXISTS acceptance_criteria (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,  -- 安定した criterion ID（grade の FK 先）
  issue_id    INTEGER NOT NULL REFERENCES issues(id),
  ordinal     INTEGER NOT NULL,                   -- 表示順（並べ替えで更新、identity には使わない）
  text        TEXT NOT NULL,                      -- criterion 本文
  enabled     INTEGER NOT NULL DEFAULT 1,         -- 1=有効/0=無効。criterion は削除せず enable/disable で切替
  created_at  TEXT NOT NULL
);
```

- **identity は `id`**（位置ではない）。並べ替えは `ordinal` の更新であり、`id` は不変。したがって AC を
  後から編集・並べ替えても、過去の grade（criterion_id 参照）は別項目へずれない。
- text の編集は同じ `id` を保つ（「同じ criterion の文言修正」）。criterion の追加は行の insert。
- **criterion は削除しない。** 不要になった criterion は `enabled = 0` に切り替える（disable）だけで、行も
  過去の grade も残す。これにより `review_ac_results.criterion_id` の FK が宙に浮くことは決して起きない。
  採点対象は `enabled = 1` の criterion のみ。disable した criterion は再び enable できる。
- markdown の `## Acceptance criteria` セクションはパースしない。構造化 AC が唯一の source。

### authoring（入力・編集経路）

1. **issue 作成時に入力** — `lh issue create` に構造化 AC を渡す（例: `--ac "<text>"` を反復）。
   現在の `lh issue create` は `--prompt` 省略時に互換用の `/lh-issue-create` skill を既定とする
   （[`cli/commands/issue.ts:98-113`](../cli/commands/issue.ts)）。**この issue 作成経路を改良して構造化 AC を
   emit させる。** New Issue ボタンが既に採る `--prompt`（直接指示）方式に寄せ、skill 前提をやめて prompt
   挿入で構造化 AC を作らせる方向を第一候補とする（§9）。
2. **作成後の管理 CLI** — `lh issue ac add|disable|enable|list`（および並べ替え）で criterion を追加・無効化・
   再有効化・一覧する。**削除コマンドは提供しない**（disable で代替）。`add` は新しい `id` を採番し
   末尾 `ordinal`・`enabled = 1` で置く。

authoring は **CLI のみ**とし、**Web UI からは AC を操作しない**（Web は §8 のとおり read-only 表示に徹する）。

パース責務を持つ core module は**設けない**（パースしないため）。代わりに構造化 AC の CRUD を担う
`core/service/*`（issue 系。例 `core/service/issues.ts` に隣接）と `core/store/*` を置く。

> **合成入力ファイルは作らない**（Verify 入力は 3 ポインタのみ、`changes.diff` 等を合成しない現行方針
> [`docs/workflow.ja.md:243-244`](./workflow.ja.md)）。構造化 AC は §6 のとおり issue view の一部として届ける。

---

## 4. grade の記録先（AC #2 の再導出）

### 検討した選択肢

| 案 | 保存先 | 長所 | 短所 |
|---|---|---|---|
| **A. `review_comments` 相乗り** | 既存 `review_comments` に構造化マーカー付きで書く | 新テーブル不要 | comment は `path` NOT NULL の file 位置アンカー（[`core/db.ts:207-217`](../core/db.ts)）。grade は file 位置を持たず意味的ミスマッチ。却下 |
| **B. reviews の子テーブル新設**（採用） | `review_ac_results(review_id → reviews(id), criterion_id → acceptance_criteria(id), verdict, note)` | review 行に紐づき head_sha pin と staleness を自動継承。`review_comments` と同じ子ファクト前例に一致。**criterion_id FK で安定紐づけ**、per-criterion クエリ・UI join が素直 | テーブル 1 つと store/serialize 層を追加 |
| **C. `reviews.ac_results_json` 列** | `reviews` に配列 JSON を格納 | 行増加なし | per-criterion クエリ/FK 参照が弱い。criterion への FK 整合を DB で保てない |

### 採用: 案 B（reviews の子テーブル、criterion_id FK）

```sql
CREATE TABLE IF NOT EXISTS review_ac_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  review_id    INTEGER NOT NULL REFERENCES reviews(id),
  criterion_id INTEGER NOT NULL REFERENCES acceptance_criteria(id),
  verdict      TEXT NOT NULL,              -- 'pass' | 'fail'
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);
```

判断根拠:

- **不変条件 1（review 行が verdict の真実源）と整合する。** grade は「その review の per-criterion 判断」で
  あり、review の子ファクトが正しい所属。line comment（`review_comments`）と同じ構造（不変条件 4）。
- **head SHA pin と staleness を追加機構なしで継承する（不変条件 2）。** grade は `review_id` 経由で review の
  `head_sha` に従属し、HEAD が進めば review もろとも stale になる。Workflow 専用の freshness は新設しない。
- **criterion_id FK で identity が安定する。** grade は criterion の安定 ID を直接参照するため、AC の編集・
  並べ替えをまたいでも対応が壊れない。旧案の「criterion_index + text スナップショット」は不要になり消える。
- **新 event 不要。** `workflow_run.review_submitted` は既に `review_id` を運ぶ（不変条件 1）。consumer は
  そこから `review_ac_results` を join すれば per-criterion を得られる。

> **既存の head SHA pin レビューとの関係。** rubric は既存レビューを**置き換えず拡張する**。review 行
> （verdict + head_sha pin）はそのまま残り、`review_ac_results` がその内訳として付く。run の遷移判断
> （`latestWorkflowRunReview` → `reviewObservation`、[`core/service/workflow-runs.ts:483-507`](../core/service/workflow-runs.ts)）は
> 従来どおり review 行の `event` だけを見るため、parent の観測ロジックは変えない。

---

## 5. 既存 verdict との対応（AC #3）

- 単一 verdict（review 行の `event`）は **run の遷移と merge gate の真実源のまま**（不変条件 1）。rubric は
  この verdict を置き換えない。
- **`event = pass` は「全 criterion が pass」かつ「blocking な自由記述 finding が無い」ときのみ。** 1 項目でも
  fail なら `request_changes`。すなわち **全 pass は pass の必要条件だが単独の十分条件ではない** — Verify は
  AC 外の欠陥（回帰・設計原則違反等）を自由記述 finding として検出したら、全 pass でも `request_changes`
  にできる。
- **自由記述 findings との共存**: 現行の review `body`（`<why>`）＋ `review_comments`（line comment）は
  変えない。`review_ac_results` はその上に載る per-criterion の構造化層として並存する。fail criterion は、
  actionable な説明を grade の `note` に残す（file 位置がある場合は関連 line comment を添えてもよいが必須ではない、§6）。
- 集計（最終的な `event`）は **Verify agent が下す**（現行どおり）。契約に上記規則を明記して誘導する。
- 記録側（`reviews.create` 経路）は、submit された grade の `criterion_id` が **その issue の enabled な
  `acceptance_criteria` に属するか**を検証する。不一致・件数過不足は**可視エラー**として拒否し、暗黙補正しない。
- **内部不整合は soft-warn（可視）で扱う（確定）。** agent が `event = pass` を出したのに fail criterion がある
  場合、hard-reject はせず、可視の warning を残して人間が気づけるようにする（可視エラー方針と「人間が
  リカバリ可能な失敗に自動機構を足さない」原則に沿う）。

---

## 6. Verify 契約への載せ方（AC #4）

### 構造化 AC の配達

- `lh issue view <n> --json` の出力に構造化 AC を含める:
  `acceptance_criteria: [{ id, ordinal, text }]`（`core/serialize.ts` に wire type 追加）。
- Verify agent は launch 時に渡される issue 参照から `lh issue view` を読み、その `acceptance_criteria` を
  rubric として採点する。**markdown の `## Acceptance criteria` は参照しない**（存在しても無視）。

### 契約の追記内容（`core/workflow/contracts/verify.{md,ja.md}`）

1. issue の構造化 `acceptance_criteria`（enabled のもの）を rubric とする。
2. 各 criterion を、固定 diff（`git diff <base>...<head>`）に対して独立に pass/fail 採点する。
3. 採点結果を review と一緒に提出する（下記 CLI）。
4. verdict は §5 の集計規則で決める。

**line comment 必須要件の撤廃（確定）。** 現行契約は `request_changes` に最低 1 件の line comment を要求する
（[`core/workflow/contracts/verify.ja.md:30-32`](../core/workflow/contracts/verify.ja.md)）。rubric 導入に合わせて
**この必須要件を撤廃する**。fail criterion は grade の `note` で actionable 性を満たせるため、file 位置を
持たない指摘に無理やり line comment を付ける必要をなくす。line comment は任意（file 位置がある指摘には添えてよい）。

### CLI サーフェス

```
lh pr review <pr> --repo '<repo>' --topic workflow --commit <head sha> \
  --event pass|request_changes --body '<why>' \
  [--comments <json|file>] [--ac-results <json|file>]
```

`--ac-results` は `[{ "criterion_id": 12, "verdict": "pass"|"fail", "note": "..." }]` の JSON。
`reviews.create`（[`core/service/reviews.ts:43-129`](../core/service/reviews.ts)）が review 行を作った後、
同一 transaction で `review_ac_results` を書き、`criterion_id` の所属を検証する（§5）。

**stdin（`-`）は使わない（確定）。** `--ac-results` は inline JSON か file path で渡す。既存の
`lh pr review --comments -`（stdin）も、two-channel 化で両方を同時に stdin へ渡せない問題を避けるため
**stdin サポートを廃止**し、inline / file path に統一する。

### 独立性の維持

- 構造化 AC は **issue の一部**（Verify が既に読む、不変条件 5）として届き、PR body・実装者説明は依然読まない。
  rubric 採点を足しても PR metadata へのアクセスは増えない。
- Verify は引き続き **fresh session** で起動され、固定 diff だけを対象にする。「Execute = pull /
  Verify = 固定ポインタ」の非対称性（§3.4 of [`docs/workflow.ja.md`](./workflow.ja.md)）は不変。
- 合成入力ファイルは増やさない。

---

## 7. 構造化 AC を持たない issue の扱い（AC #5）

- issue に `acceptance_criteria` 行が 1 件も無いとき、rubric は無く、Verify は **現行の holistic 挙動に
  フォールバック**する: 自由記述 findings ＋ 単一 verdict のみ、`review_ac_results` は 0 行。
- §5 の集計規則は degenerate し、`event` は自由記述 finding だけで決まる（＝今日の挙動）。
- **既存 issue はすべてこのフォールバックに入る**（backfill しないため）。移行は不要で、構造化 AC を
  付けた issue から順に rubric が有効になる。
- これは**エラーではない**（「人間がリカバリ可能な状況に防御機構を足さない」「最もシンプルな正解」原則、
  [`CLAUDE.md`](../CLAUDE.md)）。AC を必須化しない。UI は「AC 採点なし」を示す（§8）。

---

## 8. UI 表現（AC #6・方向性のみ）

- **issue 詳細**: 構造化 AC を **read-only のチェックリスト**として表示する（Web UI からの追加・削除・
  並べ替えは提供しない。編集は CLI のみ、§3）。serialize は issue view の `acceptance_criteria` を消費し、
  `web/src/api/types.ts` は type-only import で派生させる（[`CLAUDE.md` の Wire types 方針](../CLAUDE.md)）。
- **workflow run 表示**: `web/src/components/workflow-run-status.tsx` の `latest_review` 描画部
  （`review.event` 分岐、現状 [`:189-202`](../web/src/components/workflow-run-status.tsx)）の下に、
  criterion ごとの pass（✓）/ fail（✗）＋ `note` を出す。grade は `criterion_id` で AC テキストに join する。
- 集計は既存の `verification_status` バッジ（`verified` / `stale` / `unverified`、
  [`:74-92`](../web/src/components/workflow-run-status.tsx)）と一貫させ、`stale` のときは既存 stale 表示
  （[`:140-144`](../web/src/components/workflow-run-status.tsx)）に合わせて淡色化する。独自の freshness は持たない。
- wire type: `latest_review`（`WorkflowRunReviewSummaryWire`、[`core/serialize.ts:1578-1583`](../core/serialize.ts)）に
  `ac_results`（criterion_id・text・verdict・note）を追加し、`review_ac_results` × `acceptance_criteria` から導出する。
- 構造化 AC が無い issue はチェックリストを出さず「AC 採点なし」を示す。
- 詳細なコンポーネント実装は本書スコープ外（方向性のみ）。

---

## 9. 確定した判断・残る論点

### 確定した判断（レビューで決定）

- **criterion は削除しない。enable/disable のみ**（§3）。不要な criterion は disable し、行と過去 grade を
  残す。`review_ac_results.criterion_id` の FK が宙に浮くことは起きない。identity（並べ替え・text 編集）は
  `id` 固定で安定し、旧設計の index ドリフトは解消済み。
- **verdict と grade の内部不整合は soft-warn（可視）で扱う**（§5）。hard-reject しない。
- **`request_changes` の line comment 必須要件は撤廃**（§6）。fail criterion は grade の `note` で足り、
  line comment は任意。
- **`--comments` / `--ac-results` は stdin（`-`）を廃止**し inline / file path に統一（§6）。

### 残る論点

- **issue 作成経路の改良（要検討）。** `lh issue create` は `--prompt` 省略時に互換用の `/lh-issue-create`
  skill を既定とする（[`cli/commands/issue.ts:98-113`](../cli/commands/issue.ts)）。構造化 AC を emit させるため、
  skill 前提をやめて New Issue ボタンが既に採る `--prompt`（直接指示 / prompt 挿入）方式へ寄せる方向を第一候補と
  する。既存の「body に `## Acceptance criteria` を書く」慣習とは当面共存するが、body の AC は rubric には
  使われない（二重管理を避けるため、テンプレートから AC セクションを外す・CLI/prompt へ誘導する等は実装時に確定）。
  AC の編集は CLI のみで Web UI からは行わないため、CLI と起票経路が唯一の入力経路になる。

---

## 10. 実装分割案（AC #7）

vertical slice を意識した後続 issue の分割。各 slice は独立にレビュー可能。

1. **構造化 AC ストアと authoring** — `acceptance_criteria` テーブル（`enabled` 列含む）、`core/store` /
   `core/service` の CRUD、`lh issue ac add|disable|enable|list`（削除コマンドは無し）、`lh issue create` の
   構造化 AC 入力（`--prompt` 方式への寄せを含む）、issue view serialize（`acceptance_criteria` wire type）。
   挙動: この段階では grade はまだ無く、AC を「持てる」ようになるだけ。
2. **grade の記録** — `review_ac_results` テーブル（criterion_id FK）、store 層、`reviews.create` の
   `--ac-results` 受け入れ（stdin 無し・inline/file）と criterion 所属検証、`lh pr review --ac-results` CLI、
   serialize wire type（`latest_review` の `ac_results`）。slice 1 に依存。
3. **Verify 契約とプロンプト** — `core/workflow/contracts/verify.{md,ja.md}` に構造化 AC の採点手順・集計規則・
   フォールバックを追記し、**line comment 必須要件を撤廃**、内部不整合を soft-warn 化。slice 1・2 に依存。
4. **Web UI（read-only 表示）** — issue 詳細の AC チェックリスト read-only 表示、workflow run の
   per-criterion grade 表示と stale 表示。**AC の編集 UI は作らない**。slice 1・2 に依存。

推奨順序: 1 → 2 →（3 と 4 は 2 の後に並行可）。§9 の残る論点（issue 作成経路の改良方式）は slice 1 の
着手前に確定する。
