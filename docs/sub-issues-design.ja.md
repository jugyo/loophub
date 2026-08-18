# Sub issue の階層構造と Web UI 設計

issue が sub issue を持てるようにするための設計。sub issue は特別なエンティティではなく
通常の issue であり、親子関係と兄弟順だけを新しく持つ。JIRA の epic に相当する使い方はできるが、
epic というエンティティは導入しない。階層は **最大 3 段（根 / 子 / 孫）** とする。

> **一言で言うと:** `issues` に `parent_issue_id` と `sub_issue_ordinal` の 2 列を足し、
> 「一覧は親を持たない issue、詳細は直接の子」という 1 本の規則で core / API / UI を揃える。
> 深さは 3 段までに固定する。workspace は木ごとに 1 つで、根 issue が持ち主。子は通常の issue
> なので、workflow 開始も worktree も PR も既存経路がそのまま動く。

対象読者は LoopHub の core / web を実装する人。実装 issue の入力として使えるよう、schema、
wire shape、UI 状態、検証方針まで書く。本ドキュメントの範囲では code / schema / config を変更しない。

---

## 1. 背景と解決すべき問題

### 1.1 現在の issue モデル

`issues` は Issue と PR を `kind` で分ける単一テーブルで、行の間に関係を表す列はない
（`core/db.ts` の `SCHEMA`）。

```sql
CREATE TABLE IF NOT EXISTS issues (
  id, repo_id, number, kind, state, title, body, target_branch, author,
  created_at, updated_at,
  UNIQUE (repo_id, number)
);
CREATE INDEX IF NOT EXISTS idx_issues_repo_state ON issues(repo_id, state);
```

issue から伸びる関係は今のところ 3 種類あり、いずれも issue 間の関係ではない。

| 関係 | 実装 | 性質 |
|---|---|---|
| issue → PR | `pulls.linked_issue_id`（非 unique な FK） | 1 : N（open は soft ガードで 1 件） |
| issue → acceptance criteria | `acceptance_criteria(issue_id, number, ordinal)` | 1 : N、`ordinal` で表示順 |
| issue → session / pane / GitHub issue | `session_links` ほか | メタデータ |

`acceptance_criteria` は「親行にぶら下がる順序つきの子」を既に持っており、`ordinal` を表示順、
`id` / `number` を不変の identity として扱う規約がある（`core/store/acceptance-criteria.ts`）。
sub issue の順序はこの規約に合わせられる。

### 1.2 workspace の現在

workspace は「issue 群の統合先ローカル branch」を registry に載せただけの存在で、issue 側は
`issues.target_branch` で参照する（`core/store/workspaces.ts`、`core/service/issues.ts` の
`resolveTargetBranch`）。

- `target_branch = NULL` は「未指定」であり、既定 branch と同じ扱いになる。
  repo トップの一覧は `target_branch` が null か既定 branch の issue を既定 branch の section に
  まとめる（`web/src/components/issue-list.tsx` の `composeIssueSections`）。
  `issues.list` の workspace filter も同じ判定をする。
- workflow / PR の base branch は issue の `target_branch` から解決される
  （`core/service/dev.ts`: `input.base ?? issueRow.target_branch ?? r.default_branch`）。

つまり **issue の実効 workspace = `target_branch ?? repo.default_branch`** であり、
本ドキュメントで「main workspace」と呼ぶのはこの既定 branch のことである。

### 1.3 足りないもの

まとまった作業を複数の実施単位へ分解しても、LoopHub 上では並列に並んだ独立 issue にしかならない。

- 親から見て「残りいくつ open か」が分からない。
- 一覧が実施単位で埋まり、まとまりの粒度が読めない。
- 分解した単位それぞれで workflow を回したいのに、束ねる場所がない。

一方で、実施単位そのものは通常の issue のままでよい。worktree / branch / dev lock / workflow run は
すべて PR キーであり（`docs/worktree.ja.md`）、issue が親を持つことはそこに何も影響しない。

---

## 2. 目標と非目標

### Goals

1. issue が 0 個以上の sub issue を持ち、sub issue がさらに sub issue を持てる。
   **階層は根を 1 段目として最大 3 段**（根 / 子 / 孫）で、孫はそれ以上の子を持てない。

   > **なぜ 3 段か。** LoopHub の分解は「まとまった作業 → 実施単位」の 2 段でほぼ足りる。
   > 3 段目は、実施単位がさらに割れたときに木を作り直さずに済ませるための余裕である。
   > 上限を置くこと自体に価値がある: 深さが有界だと、祖先の breadcrumb・UI のインデント・
   > 展開の再帰段数・cascade の走査がすべて定数で収まり、「深くなったらどうするか」という
   > 例外規則が設計から消える（[D10](#7-主要な設計判断)）。逆に 4 段以上を許すと、その例外規則が
   > 全部戻ってくる割に、それで表現できるようになる作業の分解は見当たらない。
   > 上限の再評価方法は[未解決 6](#11-リスクと未解決の論点) に置く。
   > （この上限は PR #233 comment 528 での人間の決定として確定した。）
2. 同一親配下の子に安定した表示順があり、並べ替えられる。順序は慣習であって強制ではない。
3. repository トップの issue 一覧は親を持たない issue だけを返す。各行は sub issue のサマリーを
   折りたたんで持ち、クリックで展開できる。
4. issue 詳細は直接の子を、トップ一覧と同じ行 UI で表示する。
5. sub issue の行から、通常の issue と同じ操作（workflow 開始など）ができる。
6. 親 issue とその子孫は同じ workspace に属する。未指定は main workspace。
7. 既存 DB は migration 後に今と同じ見え方になる（既存 issue はすべて根）。

### Non-goals

- 順序に基づく workflow の自動実行、順序を強制する状態機械。
- epic という別エンティティ、既存 issue の種類変換。
- 親を閉じたときに子を連鎖して閉じること（[7 章](#7-主要な設計判断)で判断理由を述べる）。
- 4 段以上の階層。上限は設定可能にせず、定数 1 つで固定する。
  起票時の issue #229 は Scope と acceptance criterion 1 で「任意深さの階層」を求めていたが、
  設計中の決定でこの上限が入った。schema（adjacency list）は任意深さを表現できるので、
  上限は core の定数と UI の規則だけの問題であり、緩和しても schema は変わらない。
- 複数の親を持つ DAG 構造。親は高々 1 つ。
- repository をまたぐ親子関係。
- Web からの親子付け替え / 並べ替え UI（v1 は読み取りと「sub issue を作る」まで。[10 章](#10-実装分割案)）。

---

## 3. データモデル

### 3.1 選択肢の比較

| 案 | 形 | 利点 | 欠点 |
|---|---|---|---|
| **A: 子行に列** | `issues.parent_issue_id` + `issues.sub_issue_ordinal` | 「親は高々 1 つ」が列の性質としてそのまま表現される。トップ一覧は `parent_issue_id IS NULL` の述語 1 つで済み、join が増えない。migration は列追加 2 本と index 1 本、backfill 不要 | 子孫の一括取得に recursive CTE が要る |
| B: 中間テーブル | `sub_issues(parent_issue_id, child_issue_id, ordinal)` | 関係にメタデータ（追加者、追加時刻）を持たせられる | 「親は 1 つ」を UNIQUE index で別途担保する必要がある。最も呼ばれる一覧 query に `LEFT JOIN ... WHERE child IS NULL` が増える |
| C: closure table / materialized path | 祖先-子孫の全ペアを保持 | 子孫・祖先の取得が join 1 回 | 付け替えのたびに O(subtree × depth) 行を書き換える。今回必要なのは「直接の子」と「祖先の連鎖」だけで、投資に見合わない |

深さ上限が 3 であること（Goals 1）は案 A をさらに後押しする。C が有利になるのは深い木の子孫取得
だが、この設計では祖先も子孫も高々 2 段しかなく、案 A の recursive CTE で定数段の走査になる。

### 3.2 採用: 案 A（子行に 2 列）

```sql
-- core/db.ts の SCHEMA、issues テーブル
  parent_issue_id   INTEGER REFERENCES issues(id),
  sub_issue_ordinal INTEGER,

CREATE INDEX IF NOT EXISTS idx_issues_parent
  ON issues(parent_issue_id, sub_issue_ordinal);
```

- `parent_issue_id` — 親 issue の `issues.id`。根は NULL。
- `sub_issue_ordinal` — 同一親配下の 1 始まりの表示位置。根は NULL。
  並びは `ORDER BY sub_issue_ordinal, id`。`id` は同値時の安定 tiebreaker。

`number` ではなく `id` を参照するのは、他の issue 参照（`pulls.linked_issue_id`、
`acceptance_criteria.issue_id`、`session_links.issue_id`）と同じ規約に揃えるため。
public な参照は常に `number` で行い、内部 id は service 境界の外へ出さない
（`core/service/issues.ts` の acceptance criterion 解決と同じ扱い）。

**CHECK 制約は置かない。** `(parent_issue_id IS NULL) = (sub_issue_ordinal IS NULL)` は CHECK で
書けるが、既存テーブルへの CHECK 追加は table rebuild を要求する。`issues` は `kind` / `state` にも
CHECK を持たない既存テーブルであり、書き込み経路が core の store helper 1 本に閉じているため、
不変条件は helper と service で守る。

### 3.3 不変条件

親子関係を作る / 変える操作は、次を満たさないものを **可視のエラー**（`ServiceError` 422）で拒否する。
自動補正はしない（AGENTS.md「Prefer visible errors to automatic recovery」）。

| # | 不変条件 | 拒否理由の例 |
|---|---|---|
| I1 | 親も子も `kind = 'issue'` | `pull request cannot be a sub issue` |
| I2 | 親と子が同じ `repo_id` | `parent issue must be in the same repository` |
| I3 | 自己参照禁止（`child.id !== parent.id`） | `issue cannot be its own parent` |
| I4 | 循環禁止（新しい親が子の子孫であってはならない） | `#12 is already a sub issue of #30` |
| I5 | 親と子の実効 workspace が一致 | `sub issue must be in the same workspace as #30 (main)` |
| I6 | 付け替え後の深さが `MAX_ISSUE_DEPTH` 以内 | `sub issue nesting is limited to 3 levels` |
| I7 | 祖先 / 子孫の走査が `MAX_ISSUE_DEPTH` 段で終わる | `issue hierarchy is corrupt: #30` |

I4 は「提案された親から根へ祖先を辿り、その途中に子が現れないこと」で判定する。I6 により
祖先は高々 2 段なので、closure table を持たなくても定数段の走査で終わる。

**I6（深さ上限）** は本設計で唯一の階層に関する商品仕様上の制限である。

```
depth(根) = 1、depth(子) = depth(親) + 1
height(子を持たない issue) = 1、height(x) = 1 + max(height(x の子))

attach が許されるのは   depth(親) + height(子の subtree) <= MAX_ISSUE_DEPTH (= 3)
```

- `MAX_ISSUE_DEPTH = 3` は `core/issue-hierarchy.ts` の定数 1 つ。設定可能にはしない。
- 子だけでなく **子の subtree の高さ**を見るのは、「2 段の木を子として付ける」と合計 4 段に
  なるため。単に「親が孫でないこと」を見るだけでは足りない。
- 拒否理由は超えた側を名指しする（`#30 is already at the deepest level` /
  `#12 has sub issues of its own, so it cannot be nested under #30`）。深さは変えられないので、
  利用者の次の一手は「別の親を選ぶ」か「子側を先に detach する」になる。

**I7** は不変条件が破れた壊れたデータ（手作業の DB 編集、将来の bug）に対する保険であり、
商品仕様ではない。走査が `MAX_ISSUE_DEPTH` 段で終わらなければ、無限ループにも黙った打ち切りにも
せず可視のエラーにする（AGENTS.md「Prefer visible errors to automatic recovery」）。読み取り経路
（祖先の解決、子孫の workspace cascade）も同じ上限を共有する。

**競合**: `BEGIN IMMEDIATE`（`core/db.ts`）が直列化するのは **write transaction 同士**であって、
「読んで検証してから BEGIN して書く」という read-then-write の組ではない。検証の読みを
transaction の外に置くと、2 つの process（`lh` と `lh-web` は同じ DB を共有する）が同じ
pre-commit 状態を検証してから順に commit でき、`#12 → #30` と `#30 → #12` の同時 attach で循環が、
深さ 2 の親への同時 attach で 4 段の木ができる。

> **したがって、階層を変える procedure は検証の読みも `db.transaction` の内側に入れる。**
> 対象は attach / detach / `create --parent` / workspace cascade。`BEGIN IMMEDIATE` は
> transaction の開始時点で write lock を取るので、その内側の読みは他の writer に動かされない。
> check-then-act が 1 単位になり、上の 2 つの競合は起こらなくなる。

同 file の `acReorder` は検証を transaction の外に置いているが、そちらの競合が生むのは
「並び順が意図と違う」だけで、detach も要らずもう一度 reorder すれば直る。ここで守るのは
**構造の不変条件**であり、壊れると木が循環したり 4 段になったりして、後続の走査が I7 で
落ち始める。だから同じ file の中で扱いを変える。

`docs/command-transaction-boundaries.ja.md` が transaction の外に出せと言っているのは
**git / spawn / HTTP / filesystem** であって DB の読みではないので、この判断はその規約と衝突しない。
`create --parent` の branch 検証（`resolveTargetBranch`）は git を叩くため、従来どおり
transaction に入る前に済ませる。

### 3.4 workspace の意味論

> **木ごとに workspace は 1 つ。持ち主は根 issue。**

- 実効 workspace = `target_branch ?? repo.default_branch`（[1.2](#12-workspace-の現在)）。
  未指定の issue 同士は「どちらも main workspace」として一致する。
- **子の作成**（`issues.create --parent`）: 子は親の `target_branch` をそのまま継承する。
  `--workspace` / `--target-branch` を同時に指定して不一致になる場合は 422。
  親から作る通常の流れでは workspace を意識しなくてよい。
- **既存 issue の attach**: 実効 workspace が親と違えば I5 で拒否する。attach の副作用として
  子の subtree を書き換えることはしない（利用者が意図していない移動を黙って行わないため）。
  移したい場合は先に workspace を変えてから attach する。
- **workspace の変更**: `issues.update` の `workspace` / `target_branch` 変更は
  **根 issue に対してのみ許可**し、その subtree 全体へ同じ transaction で cascade する。
  根でない issue への変更は 422 `change the workspace on the root issue #n`。
  これにより「木は 1 つの workspace」が 1 つの規則で保たれる。
- **detach**: 子は現在の workspace のまま新しい根になる。不変条件は保たれるので追加処理は不要。
- **不正状態**: 手作業の DB 編集や将来の bug で不一致が生じた場合、読み取り経路は補正しない。
  一覧は根の workspace section に、詳細は現状の値をそのまま表示する。修復手順は
  「detach → workspace を揃える → 再 attach」であり、これを本節の運用手順とする。

### 3.5 Migration と後方互換性

`npm run migration:new -- <name>` が生成する UTC timestamp ID を使い、`MIGRATIONS` 末尾に
3 entry を追加する（`addColumn` は列が既にあれば skip する guard 付き、index は `sql`）。

```ts
addColumn("<ts>-issues-parent-issue-id", "issues", "parent_issue_id",
          "INTEGER REFERENCES issues(id)"),
addColumn("<ts>-issues-sub-issue-ordinal", "issues", "sub_issue_ordinal", "INTEGER"),
sql("<ts>-issues-parent-index",
    `CREATE INDEX IF NOT EXISTS idx_issues_parent
       ON issues(parent_issue_id, sub_issue_ordinal);`),
```

- SQLite の `ALTER TABLE ADD COLUMN` は default が NULL であれば `REFERENCES` 付きの列を追加できる。
- **backfill しない**。既存行は `parent_issue_id IS NULL` = 根となり、
  「一覧は根のみ」という新しい規則の下でも今日と同じ集合を返す。
- `core/db.ts` の `SCHEMA` にも同じ列と index を書き足す。`core/migrations.test.ts` が
  新規 DB と migration 済み DB の schema を比較するので、片方だけの変更は test で落ちる。
- ロールバックは想定しない（LoopHub の migration は前進のみ）。旧バージョンの `lh` が新 schema の
  DB を読んでも、未知の 2 列を無視するだけで動作は変わらない。

---

## 4. Core の責務分担

### 4.1 store（`core/store/issues.ts`）

`IssueRow` に `parent_issue_id: number | null` と `sub_issue_ordinal: number | null` を追加し、
次の helper を足す。SQL と単一行の書き込みだけを持ち、判断は持たない。

| helper | 役割 |
|---|---|
| `listIssues(repoId, kind, state, sort, opts?: { rootsOnly?: boolean })` | 既存 signature を保ち、`rootsOnly` で `AND parent_issue_id IS NULL` を足す。現行の caller（`issues.list` と `dashboard`）はどちらも `true` を渡す。store は機械的な filter だけを持ち、「一覧は根のみ」という規則自体は service 側に置く |
| `listSubIssues(parentId): IssueRow[]` | 直接の子を `ORDER BY sub_issue_ordinal, id` で返す |
| `subIssueSummariesByParent(parentIds): Map<number, {total, open, closed}>` | 一覧のサマリー用。`GROUP BY parent_issue_id` の 1 query |
| `setIssueParent(childId, parentId \| null, ordinal \| null)` | 2 列を同時に書く単一 statement |
| `nextSubIssueOrdinal(parentId): number` | `COALESCE(MAX(ordinal), 0) + 1`（`addAcceptanceCriterion` と同型） |
| `reorderSubIssues(parentId, orderedChildIds)` | `ordinal` の書き直し（`reorderAcceptanceCriteria` と同型） |
| `listAncestorRows(issueId, limit): IssueRow[]` | 根方向へ recursive CTE、`limit` で打ち切り（最大 2 行） |
| `listDescendantIds(issueId, limit): number[]` | workspace cascade と循環検査用 |
| `subtreeHeight(issueId, limit): number` | 子孫を深さ付きで辿った最大段数。attach の I6 判定用。`limit` を超えたら例外 |

`ordinal` の空きは埋めない。detach で欠番ができても `ORDER BY sub_issue_ordinal, id` の並びは
変わらないため、暗黙の再採番はしない（`acceptance_criteria` と同じ判断）。

### 4.2 純粋な判定モジュール（`core/issue-hierarchy.ts`）

AGENTS.md の「Pure, side-effect-free decisioning は自前の core module に置く」に従い、
[3.3](#33-不変条件) の判定を DB アクセスを持たない関数として切り出す
（`core/worktree-prune.ts` と同じ位置づけ）。

```ts
/** 根を 1 段目とした階層の上限。設定可能にはしない（理由は本書 2 章 Goals 1）。 */
export const MAX_ISSUE_DEPTH = 3;

export type AttachRejection =
  | { kind: "not_an_issue" } | { kind: "cross_repo" } | { kind: "self" }
  | { kind: "cycle"; ancestorNumber: number }
  | { kind: "workspace_mismatch"; parentWorkspace: string; childWorkspace: string }
  | { kind: "parent_too_deep"; parentDepth: number }
  | { kind: "child_subtree_too_tall"; parentDepth: number; childHeight: number };

export function rejectAttach(input: {
  child: IssueFacts;
  parent: IssueFacts;
  parentAncestorNumbers: number[];   // 親から根へ、store が読んだ順。長さ + 1 が親の深さ
  childSubtreeHeight: number;        // 子を根としたときの段数（子を持たなければ 1）
  defaultBranch: string;
}): AttachRejection | null;

export function effectiveWorkspace(targetBranch: string | null, defaultBranch: string): string;

/** UI / CLI が「これ以上ぶら下げられるか」を尋ねるための述語。rejectAttach と同じ定数を使う。 */
export function canHaveSubIssues(depth: number): boolean;   // depth < MAX_ISSUE_DEPTH
```

service は行を読んでこの関数に渡し、返った rejection を `ServiceError(422, message)` に写す。
判定そのものは git も DB も要らないので、単体 test は行の形だけで書ける。深さの判断が
`rejectAttach` と `canHaveSubIssues` の 2 つに閉じているため、UI / CLI / service が別々に
「3」を書くことはない。

### 4.3 service procedure（`core/service/issues.ts`）

sub issue は issue の関係なので、新しい noun を作らず `issues` に procedure を足す。

| procedure | 内容 | transaction owner |
|---|---|---|
| `issues.create(..., { parent })` | 親の検証（深さ < 3 を含む）→ workspace 継承 → 既存の create 経路 → `sub_issue_ordinal` 採番 → `issue.opened` + 親の `issue.updated` | procedure（既存どおり） |
| `issues.attachSubIssue(repo, parent, child)` | 検証（I1〜I7）→ `setIssueParent` → 子・新旧親の `issue.updated` | procedure |
| `issues.detachSubIssue(repo, child)` | `setIssueParent(child, null, null)` → 子・元親の `issue.updated` | procedure |
| `issues.reorderSubIssues(repo, parent, orderedNumbers)` | 完全な順列であることを検証 → `reorderSubIssues` → 親の `issue.updated` | procedure |
| `issues.listSubIssues(repo, number)` | 直接の子を list と同じ enrich で返す（読み取り） | — |
| `issues.update`（既存） | workspace 変更時に「根であること」を検証し、subtree へ cascade | procedure（既存） |

いずれも state 変更と event を同じ commit 単位に置く。`docs/command-transaction-boundaries.ja.md`
の procedure 一覧に 4 行を追加する（実装スライスの成果物）。

**階層を変える 4 つ**（`create` の親指定 / `attachSubIssue` / `detachSubIssue` / `update` の
workspace cascade）は、[3.3](#33-不変条件) のとおり **検証の読みも transaction の内側**に置く。
表の「内容」欄で「検証 →」と書いてある部分は、`db.transaction` の callback の先頭にあるという意味である。
`reorderSubIssues` は例外で、検証（順列かどうか）は外でよい — 競合しても壊れるのは並び順だけで、
もう一度 reorder すれば直る。

`reorderSubIssues` の順列検証は `acReorder` の写し。「その親の子を過不足なく 1 回ずつ挙げること」を
要求し、部分指定は 422 で拒否する。

### 4.4 Event

**新しい event type は導入しない。** 親子の変更は関係する issue それぞれの `issue.updated` として
発火する（子、旧親、新親）。理由は 3 つ。

- `core/event-subjects.ts` は `issue.*` の subject を payload の `number` から解決する。
  既存の形に乗るので subject 解決は変更不要で、issue 一覧と当該 issue 詳細が正しく refetch される。
- 新 type は worker / notification / event 表示のすべてに consumer 側の対応を要求する
  （`docs/legacy-event-type-decisions.md` が残す教訓）。
- 「何が変わったか」は行を読めば分かる。event は「変わったこと」を伝えれば足りる。

**Web の invalidation map（`web/src/lib/event-keys.ts`）も変更しないが、それは自動的ではない。**
同 file は `issue.*` に対して `["issues", repo]` と `["issue", repo, <event の number>]` を積むだけで
（number が無いときだけ広い `["issue", repo]`）、invalidate は prefix 一致
（`web/src/lib/use-loophub-events.ts`、`exact` 指定なし）である。したがって:

- sub issue 展開の query key を `["issue", repo, <親>, ...]` の下に置くと、`issue.*` については
  **親の number を載せた event でしか落ちない**。attach / detach / reorder は親にも
  `issue.updated` を出すので更新されるが、**子自身の `issue.closed` / `issue.updated` は
  子の number しか載せない**ので親の key を落とさない。展開したまま子が close された場合に、
  親行の `sub k/n` chip だけが更新されて展開済みの子行が固まる、という定常的なズレになる。
  （`pull_request.*` は別で、`event-keys.ts` が repo 全体の prefix `["issue", repo]` を積むため
  どちらの置き場所でも落ちる。狭い key の問題は `issue.*` 側だけで起きる。）
- そこで key は `queryKeys.issues(full)` 配下（`["issues", full, "sub", n]`）に置く。
  repo 内のすべての `issue.*` が `queryKeys.issues(repo)` を積むので、子自身の event でも
  子行が追従する。`pull_request.*` も同じ key を積む。結果として `event-keys.ts` に手を
  入れずに済む。詳細は [6.1](#61-repository-トップwebsrccomponentsissue-listtsx--dashboard-rowstsx)。

---

## 5. Wire shape と API

### 5.1 `IssueWire` の追加フィールド

`core/serialize.ts` が wire shape の single source of truth なので、型はすべてここに置く
（`web/src/api/types.ts` は type-only import で導出する既存方針を維持）。

```ts
export interface SubIssueSummaryWire {
  total: number;   // 直接の子の数
  open: number;
  closed: number;
}

export interface IssueRefSummaryWire {   // 祖先の breadcrumb 用
  number: number;
  title: string;
  state: "open" | "closed";
}

export interface IssueWire {
  // ...既存
  /** 根を 1 とした階層（1..MAX_ISSUE_DEPTH）。list / detail の両方に載る。 */
  depth?: number;
  /** 同一親配下の表示位置。根では null。 */
  sub_issue_ordinal?: number | null;
  /** 直接の子の集計。子を持たない issue では省略（acceptance_criteria と同じ扱い）。 */
  sub_issue_summary?: SubIssueSummaryWire;
  /** 根から直接の親までの祖先。detail 応答のみ。根では空配列、最大 2 要素。 */
  ancestors?: IssueRefSummaryWire[];
  /** 直接の子。detail 応答と sub issue 展開応答のみ。 */
  sub_issues?: IssueWire[];
  sub_issues_truncated?: boolean;
}
```

**再帰の打ち止め**: `sub_issues` に入る子行は `sub_issue_summary` を持つが、自分の `sub_issues` は
持たない。1 応答 = 1 階層。次の階層は UI が展開時に要求する（[5.3](#53-eager--lazy-の分界)）。
深さ上限が 3 なので、この要求は根から数えて高々 2 回で終わる。

`ancestors` は根始まりで、`at(-1)` が直接の親。深さ上限 3 のため要素数は 0〜2。`parent` という
別フィールドは置かない（同じ情報が 2 か所にあると片方が古くなる）。

`depth` を wire に載せるのは、UI と CLI が「この issue にまだ子をぶら下げられるか」
（= `depth < MAX_ISSUE_DEPTH`）を、親を辿り直さずに判断できるようにするため。値は
`ancestors.length + 1` と一致するが、`ancestors` を持たない一覧応答でも必要になる。

### 5.2 「一覧は根、詳細は直接の子」

| 経路 | 返すもの |
|---|---|
| `issues.list` | 親を持たない issue **のみ**。各行に `sub_issue_summary` |
| `issues.listSubIssues(repo, n)` | `#n` の直接の子。一覧行と同じ enrich。detail と同じ `MAX_ISSUE_DETAIL_SUB_ISSUES` で truncate |
| `issues.get`（detail） | `ancestors` と `sub_issues`（直接の子、`MAX_ISSUE_DETAIL_SUB_ISSUES` で truncate） |
| `search.query` | 変更なし。sub issue も通常どおりヒットする |
| `dashboard`（cross-repo の Recent issues） | 根のみ。行に `sub_issue_summary` を載せる |

**「issue 一覧 = 親を持たない issue」に例外を作らない。** 階層を平坦にして全件を返す選択肢
（`scope: "all"` のような param、CLI の `--all`）は置かない。理由は 2 つ。

- 状態 filter（`state` の open / closed / **all**）は「どの状態の issue を見るか」の軸であり、
  階層とは直交する。`state: "all"` でもトップレベルの issue だけを返すのが一貫している。
  ここに別の「all」を足すと、2 つの all が同じ画面で違う意味を持つ。
- 平坦一覧が無くても、子には到達できる。一覧の `sub_issue_summary` → 展開 / `lh issue sub list`、
  issue 詳細の `sub_issues`、そして `search.query`（sub issue も従来どおりヒットする）がある。
  深さが 3 段までなので、木を辿る手数も有界である。

この規則を core 側に置くのは、データ選択の意味論を core に持たせる既存方針（AGENTS.md
「Keep data-selection semantics in `core`」）に従うため。既存 DB では全件が根なので挙動は
変わらない。dashboard も同じ規則に揃える。活動中の sub issue が cross-repo の digest に
出なくなるが、親行のサマリーが残数を示すので許容する。

`MAX_ISSUE_DETAIL_SUB_ISSUES`（例: 50）は `MAX_ISSUE_DETAIL_PULLS = 24` と同じ位置づけの上限で、
`core/store/pulls.ts` ではなく `core/store/issues.ts` に置く。これは **深さではなく幅**の上限で、
`MAX_ISSUE_DEPTH` とは独立している。超過は `sub_issues_truncated` で可視化する（黙って切らない）。

**この上限は detail と展開の両方に効かせる。** 一覧の子行を lazy にした理由が「幅を制限して
いないから 1 応答が重くなりうる」である以上（[5.3](#53-eager--lazy-の分界)）、その lazy 経路
（`pageData/subIssues`）が無制限に enrich したのでは一貫しない。子 100 件の親を 1 回展開すると、
一覧が避けたはずの git fan-out をそのまま払うことになる。上限を超えた展開は詳細と同じく
`sub_issues_truncated` を立て、UI は末尾に truncate 行を出す（[6.3](#63-状態)）。

`depth` の埋め方は経路ごとに定数コストで決まる。一覧は常に 1（根しか返さないため）、
`listSubIssues(repo, n)` は `#n` の深さを 1 回解決して +1、detail は `ancestors.length + 1`。
行ごとに祖先を辿る経路はどこにもない。

### 5.3 eager / lazy の分界

repo トップは既に最も重い画面で、行ごとに linked PR の git fan-out を払っている
（`core/serialize-status.ts` の `linkedPullDetail`）。子行を一覧応答に同梱すると、この fan-out が
子の数だけ増える。

したがって **サマリーは eager、子行は lazy**とする。

| データ | 取得 | 根拠 |
|---|---|---|
| `sub_issue_summary`（折りたたみ時の表示に必要） | 一覧応答に同梱。`GROUP BY parent_issue_id` の 1 query | ページあたり定数コスト。git を呼ばない |
| 子行そのもの | 展開時に `pageData/subIssues` を 1 回。`MAX_ISSUE_DETAIL_SUB_ISSUES` で有界 | 既定は折りたたみなので、多くの閲覧で子の enrich は発生しない |
| issue 詳細の子行 | detail 応答に同梱 | 単一 issue の画面であり、上限つきで有界。AC の「詳細は直接の子を返す」に一致 |

`docs/web-rpc-eager-lazy-judgment-2026-08-10.ja.md` の判断（表示は既定 lazy、eager 化は
決定的で安いスライスに限る）と同じ線引きである。

深さが 3 に固定されても、**根の子孫を一覧応答に同梱する形には変えない**。制限がかかったのは
深さだけで、幅（1 つの親が持てる子の数）は制限していない。子 20 件 × 孫 5 件の木は 3 段でも
100 行の enrich になり、一覧が払う git fan-out としては重すぎる。

### 5.4 JSON-RPC 契約（`web/server/contract.ts`）

| method | params | 備考 |
|---|---|---|
| `issues/list` | 変更なし | 返す集合が根のみに変わる。param は増やさない（[5.2](#52-一覧は根詳細は直接の子)） |
| `issues/create` | 既存 + `parent: positiveInt` | 親の workspace を継承 |
| `pageData/subIssues` | `{ repo, number }` | `{ issues: IssueWire[], truncated: boolean, workflow_runs }` を返す。展開 1 回 = 1 request。`MAX_ISSUE_DETAIL_SUB_ISSUES` で truncate（[5.2](#52-一覧は根詳細は直接の子)） |
| `issues/sub/attach` | `{ repo, parent, child, session_id }` | |
| `issues/sub/detach` | `{ repo, child, session_id }` | |
| `issues/sub/reorder` | `{ repo, parent, order: number[], session_id }` | `order` は子の number |
| `terminal/launch`（既存） | 既存 + `parentIssue: positiveInt` | `New sub issue` が起動する `lh issue new --parent`（[6.5](#65-new-sub-issue-の配線)）。`issue-create` workflow のときだけ意味を持つ |

`pageData/subIssues` が `workflow_runs` も返すのは、展開された子行の mini tracker が
`pageData/issueList` と同じ seed を必要とするため（`docs/issue-list-workflow-run-state.ja.md` の
#112 と同じ理由 — 行ごとに要求すると 1 event で全行が invalidate される）。
同じ理由で **`pageData/issueDetail` の応答（`IssueDetailPageWire`）にも `workflow_runs` が増える**。
現状は `{ issue, comments, acceptance_criteria }` だけで、子行の tracker を seed する場所がない。

method を足したら `npm run contract` で `docs/rpc-contract.json` を再生成して同じ commit に含める。

### 5.5 CLI（`cli/commands/issue.ts`）

`lh issue ac` と同じ形の subcommand group を足す。CLI は flag 解析と表示だけを持ち、
判断は core にある。

```
lh issue create --parent <n> [--title ...] [--ac ...]   # 親の workspace を継承して子を作る
lh issue new --parent <n> [--prompt ...]                # AI session で子を起票する（Web の New sub issue）
lh issue sub list <parent>                              # 直接の子
lh issue sub add <parent> <child>                       # 既存 issue を子にする
lh issue sub remove <child>                             # 親から外す（根になる）
lh issue sub reorder <parent> --order 31,12,44          # 子 number の完全な順列
lh issue list [--state open|closed|all]                 # 常に根のみ（--state は状態の軸で階層とは直交）
lh issue view <n> [--json]                              # ancestors と sub issues を含む
```

`lh issue new --parent` は `--target-branch` と同じ形で、spawn する runtime の env
（`LOOPHUB_PARENT_ISSUE`）に親を載せる。session の中で agent が叩く `lh issue create` が
その env を読み、`--parent` 未指定でも子として起票する。Web の `New sub issue` はこの経路の
入口であり、配線の全段は [6.5](#65-new-sub-issue-の配線) にある。

- `lh issue list` の text 出力は行末に `sub 2/5`（closed/total）を足す。
  子を平坦に見る flag は無いので、子へ降りる導線は `lh issue sub list <n>` を案内する
  （sub issue を持つ行が 1 つでもあれば末尾に 1 行）。
- `lh issue view` の text 出力は body の後に `Sub issues` 節（`#n [state] title`）と、
  親がある場合の `Parent: #12 › #30` 行を出す。`--json` は wire をそのまま出す。
- 深さ上限に当たった `sub add` / `create --parent` は core の 422 をそのまま stderr に出す。
  CLI 側で深さを数え直したり、上限を回避する再試行をしたりはしない。

---

## 6. Web UI

### 6.1 repository トップ（`web/src/components/issue-list.tsx` / `dashboard-rows.tsx`）

```
┌ main ─────────────────────────────────────────────────────────────────┐
│ ▸ #30  決済フローを刷新する            [sub 2/5]        3h   💬2      │  depth 1
│     └ PR #31  ● review                                                │
│ ▸ #44  検索を作り直す                  [sub 0/3]        1d            │
│ #52  ログイン画面の余白を直す                            2d           │
└───────────────────────────────────────────────────────────────────────┘

展開後（最大 3 段。3 段目には disclosure が出ない）:
│ ▾ #30  決済フローを刷新する            [sub 2/5]        3h   💬2      │  depth 1
│     └ PR #31  ● review                                                │
│    ▸ #33  決済 API の契約を決める      [sub 0/2]  closed  5h          │  depth 2
│      #34  Stripe client を差し替える              [Start workflow ▾]  │  depth 2
│    ▾ #35  移行 script を書く           [sub 1/1]        2h            │  depth 2
│        #36  dry-run mode                          [Start workflow ▾]  │  depth 3
```

- **開閉**: `sub_issue_summary.total > 0` の行にだけ、`#number` の左に disclosure（chevron）と
  `sub k/n` chip を出す。**既定は折りたたみ**。chip 自体も開閉の trigger にする。
  深さ 3 の行は子を持てないので、どちらも出ない。
- **展開**: `pageData/subIssues` を TanStack Query で取得する。query key は
  `queryKeys.subIssues(full, n) = [...queryKeys.issues(full), "sub", n]`（= `["issues", full, "sub", n]`）。
  **`queryKeys.issue(full, n)` 配下には置かない** — その位置では親の number を載せた event でしか
  落ちず、子自身の close や子の PR の進行で展開済みの行が固まる（[4.4](#44-event) 参照）。
  `issues` 配下なら、repo 内の `issue.*` と `pull_request.*` の両方が既存の invalidation 経路で
  この key を落とすので、`web/src/lib/event-keys.ts` は変更不要。
  代償として、無関係な issue の event でも展開中の子一覧が refetch される。これは issue 一覧本体が
  既に払っているコストと同じで、同時に展開されている親の数だけしか増えない（既定は折りたたみ）。
  一方、狭い key の取りこぼしは「画面が黙って古くなる」形で現れる。粗い invalidate を選ぶ。
- **入れ子**: 子行も同じ `IssueRow` を使い、同じ chip / disclosure を持つ。展開は再帰的に
  行われるが、深さ上限 3 により再帰は高々 2 段で止まる。インデントは 1 段 `pl-6` の固定で、
  最も深い行でも `pl-12` を超えない。折り返しや横スクロールの心配がないため、
  「深くなったらインデントを打ち切る」ような例外規則は要らない。
- **開閉状態**: `IssueList` の局所 state（`Set<number>`）に持つ。URL には載せない。
  リロードや画面遷移で畳まれるのは許容する（既定が折りたたみである以上、失われる情報はない）。
- **workspace section**: 子は必ず親と同じ workspace なので、常に親の section 配下に描画する。
  section の割り当ては根 issue だけで決まる。

### 6.2 issue 詳細（`web/src/components/issue-detail.tsx`）

`IssueHeader` → `LinkedPullSummary` → **`SubIssueSection`** → `IssueHerdrSection` → 議論、の順に置く。
親 issue 自身の PR が上、その下に分解した実施単位が来る並びになる。

- `SubIssueSection` は `pageData/issueDetail` が返した `sub_issues` を、**repo トップと同じ
  `IssueRow`** で描画する（AC 4 の「同じ UI」）。行の中身も同じなので、linked PR の sub-row も
  `Start workflow` も自動的に付いてくる。
- 子が 0 件のときは節ごと出さない。`sub_issues_truncated` のときは末尾に
  `Showing first 50 sub issues` を出す。
- **親への導線**: `IssueHeader` の badge 行に `ancestors` から breadcrumb を出す
  （`#12 › #30`、各要素が issue 詳細への Link）。要素は高々 2 つなので折り返しを考えなくてよい。
  根では出さない。
- **子の作成**: 節の見出し右に `New sub issue`。`CreateIssueButton` を再利用するが、
  この button は issue を作らず coding agent の session を起動するだけなので、
  親 issue 番号を session まで運ぶ配線が要る（[6.5](#65-new-sub-issue-の配線)）。
  `depth === MAX_ISSUE_DEPTH` の issue ではこの button を出さない
  （`canHaveSubIssues(issue.depth)` で判定し、UI 側に 3 を書かない）。
- 詳細の子行も mini tracker を持つので、`pageData/issueDetail` は
  `pageData/issueList` と同様に子の linked PR について `workflow_runs` を seed する。

### 6.3 状態

| 状態 | 表示 |
|---|---|
| 折りたたみ（既定） | chip `sub k/n` のみ。追加の request なし |
| 展開・loading | 親行の下に 1 行のスケルトン + `Loader2`（一覧の既存 loading と同じ語彙） |
| 展開・error | 親行の下に破線枠のエラー行 + `Retry`。一覧全体は落とさない |
| 展開・空 | `No sub issues`。サマリーと子一覧は別 response なので、event 直後の refetch が揃うまでの一瞬だけ「`sub 0/2` なのに空」が起こりうる。[6.1](#61-repository-トップwebsrccomponentsissue-listtsx--dashboard-rowstsx) の key 配置により、どちらも同じ event で落ちて追従する |
| 展開・truncate | 応答の `truncated` が真なら末尾に `Showing first 50 sub issues`。chip の `sub k/n` は総数のままなので、表示件数との差はこの行が説明する |
| 最下段（`depth === 3`） | disclosure も `sub k/n` chip も `New sub issue` も出さない。行は通常の issue 行と同じ |
| 壊れたデータ（4 段以上 / 循環） | 描画中の path に現れた number が再度出るか、深さが `MAX_ISSUE_DEPTH` を超えたら再帰せず、`階層が不正` badge の行を出して打ち切る |

深さ超過と循環は [3.3](#33-不変条件) の I4 / I6 で書き込み時に拒否するが、UI 側でも path と深さで
防ぐ。壊れたデータでブラウザが固まるより、可視の badge で気付けるほうがよい。

### 6.4 sub issue からの操作

`IssueRow` は既に `StartWorkflowControls` を `state === "open" && has_open_pull_request === false`
の条件で描画する。sub issue 行は同じ component の同じ props で描かれるので、**workflow 開始に
特別扱いは要らない**。開始後の PR / worktree / dev lock はすべて PR 番号キーで、親子関係とは
独立している（`docs/worktree.ja.md`）。base branch は子の `target_branch` から解決され、
[3.4](#34-workspace-の意味論) の不変条件により親と同じ workspace になる。

### 6.5 `New sub issue` の配線

`CreateIssueButton` は issue を作らない。`launchTerminal({ workflow: "issue-create" })` で
coding agent の session を起動するだけで、issue を作るのは session の中で agent が叩く
`lh issue create` である（`web/src/components/create-issue-button.tsx`）。したがって
「button に `parent` を渡す」だけでは親は届かず、**既存の `targetBranch` prop と同じ経路を
`parentIssue` にも通す**必要がある。

| # | 場所 | 追加するもの |
|---|---|---|
| 1 | `web/src/components/create-issue-button.tsx` | prop `parentIssue?: number` → `launchTerminal({ ..., parentIssue })`。button の副題は `in <branch>` に倣って `sub issue of #<n>` |
| 1b | 同上 | **prompt にも親を載せる**: `issueCreatePrompt(settings?.workflowContractLanguage, parentIssue)` を呼ぶ。`issue-create` の prompt は core ではなくこの component が組み立てて `launchTerminal({ prompt })` に載せており、`core/service/terminal.ts` はそれを `lh issue new --prompt` にそのまま渡すだけなので、ここを直さないと Web 起点の起票では親が env にしか乗らない |
| 2 | `web/src/components/terminal-controller.tsx` | launch options に `parentIssue` |
| 3 | `web/src/api/client.ts` | `launchTerminal` の params に `parentIssue` |
| 4 | `web/server/contract.ts` | `terminal/launch` の params に `parentIssue: positiveInt` |
| 5 | `core/service/terminal.ts` | `issue-create` のときだけ下へ渡す（`targetBranch` と同じ扱い） |
| 6 | `core/terminal/terminal-launch.ts` | 起動 command に ` --parent <n>` を足す（`shellArg` で escape） |
| 7 | `cli/commands/issue.ts` の `new` | `--parent` を受け、spawn する runtime の env に `LOOPHUB_PARENT_ISSUE` を載せる（`LOOPHUB_WORKSPACE` と同じ形） |
| 8 | `cli/commands/issue.ts` の `create` | `flags.parent ?? process.env[ENV_PARENT_ISSUE]` を読む（`--target-branch` の env fallback と同じ形） |
| 9 | `core/environment.ts` | `ENV_PARENT_ISSUE = "LOOPHUB_PARENT_ISSUE"` |

**workspace と違って prompt にも出す。** `targetBranch` は env だけで運ばれ、prompt には現れない。
sub issue では親が仕様そのものなので、`core/workflow/issue-create-prompt.ts` の
`issueCreatePrompt(language)` に親 issue 番号を受ける引数を足し、「`#<n>` の sub issue として、
親の acceptance criteria に収まる粒度で起票する」という 1 文を加える。env だけでは、agent は
親を読まずに範囲のずれた子を起票しうる。

この関数の**呼び出し側は 2 つあり、両方を直す**必要がある。Web 起点は上表の 1b
（`create-issue-button.tsx`）、CLI 起点は `cli/commands/issue.ts` の `new`（`--prompt` 未指定時の
fallback として同じ関数を呼んでいる）。片方だけ直すと、そちらの経路でだけ親が prompt に乗らない。

親が深さ 3 だった場合は button を出さないが（[6.2](#62-issue-詳細websrccomponentsissue-detailtsx)）、
起票時点で親が別の木へ移動している可能性はある。最終的な拒否は `lh issue create` が呼ぶ
[3.3](#33-不変条件) の検証であり、UI は先回りの案内にすぎない。

---

## 7. 主要な設計判断

| # | 判断 | 根拠 / 既存規約との整合 |
|---|---|---|
| D1 | 親子は子行の 2 列で表す | 「親は高々 1 つ」を型で表現でき、最も重い一覧 query に join を足さない |
| D2 | 順序は `sub_issue_ordinal`、欠番は埋めない | `acceptance_criteria` の `ordinal` / `reorder` 規約をそのまま踏襲 |
| D3 | 一覧は常に根のみ。平坦化する逃げ道（`scope` param / `--all`）を作らない | データ選択の意味論を core に置く（AGENTS.md）。状態 filter の `all` と階層は直交する軸で、同じ画面に 2 つの all を持ち込まない。子へは `sub_issue_summary` → 展開 / `lh issue sub list` / detail / search で到達できる。既存データでは挙動不変 |
| D4 | workspace は木単位、変更は根からのみ | 不変条件を 1 つの規則で保てる。`dev.openPr` の base 解決を変えずに済む |
| D5 | 新 event type を足さず `issue.updated` を使う | subject 解決と Web invalidation が無改造で通る。consumer への波及を作らない |
| D6 | 折りたたみサマリーは eager、子行は lazy | 一覧の git fan-out を増やさない。eager/lazy 判断ドキュメントの線引きと同じ |
| D7 | 親を閉じても子は閉じない | sub issue は通常の issue であり、Non-goals の「順序を強制しない」と同じ立場。残りは `sub k/n` で見える |
| D8 | 循環 / 深さは可視のエラーで拒否し、自動補正しない | AGENTS.md「Prefer visible errors to automatic recovery」 |
| D9 | Web の親子編集は v1 では持たない | 分解は agent / CLI が行う運用が先。読み取りと「子を作る」だけで AC を満たす |
| D10 | 階層は最大 3 段。設定可能にしない | 分解は「まとまった作業 → 実施単位」の 2 段でほぼ足り、3 段目は割れたときの余裕。定数 1 つに閉じることで、UI のインデント規則・`ancestors` の長さ・展開の再帰段数・cascade の走査がすべて有界になり、深さ由来の例外規則が設計から消える（[2 章 Goals 1](#goals)） |
| D11 | 深さ判定は `depth` + `subtreeHeight` の 2 値で行う | 「親が孫でない」だけでは 2 段の木を子として付けたときに 4 段になる。attach 時に両側を見るのが最小の正しい判定 |
| D12 | 階層を変える procedure は検証の読みも transaction の内側に置く | `BEGIN IMMEDIATE` が直列化するのは writer 同士だけで、読みが外にあると check-then-act が原子的でない。守るのは構造の不変条件で、壊れると木が循環・4 段になり後続の走査が I7 で落ち始める（`acReorder` の並び順と違って、やり直しでは直らない）。読みは DB のみなので transaction 境界の規約（外部 I/O を入れない）とも衝突しない |

---

## 8. 影響範囲

| 層 | ファイル | 変更 |
|---|---|---|
| schema | `core/db.ts`, `core/migrations.ts` | `issues` に 2 列 + index、migration 3 entry |
| store | `core/store/issues.ts` | `IssueRow` 拡張、[4.1](#41-storecorestoreissuests) の helper |
| 判定 | `core/issue-hierarchy.ts`（新規） | 不変条件の純粋関数、`MAX_ISSUE_DEPTH = 3`、`canHaveSubIssues` |
| service | `core/service/issues.ts` | attach / detach / reorder / listSubIssues、create の `parent`、update の workspace cascade |
| service | `core/service/page-data.ts` | `issueDetail` に子と `workflow_runs` の seed、`subIssues` の追加 |
| service | `core/service/dashboard.ts` | 根のみに絞る |
| serialize | `core/serialize.ts` | `SubIssueSummaryWire` / `IssueRefSummaryWire` / `IssueWire` の追加フィールド（`depth` を含む）、`IssueDetailPageWire` に `workflow_runs`（詳細の子行にも mini tracker を出すため。現状は `{ issue, comments, acceptance_criteria }` のみ）、`SubIssueListPageWire` の追加 |
| serialize | `core/serialize-status.ts` | 一覧・詳細への `depth` / `sub_issue_summary` / `sub_issues` / `ancestors` の載せ込み、`IssueListSelection` に `subIssueSummariesByParent` を追加 |
| RPC | `web/server/contract.ts`, `docs/rpc-contract.json` | [5.4](#54-json-rpc-契約webservercontractts) の method、`terminal/launch` の `parentIssue` |
| CLI | `cli/commands/issue.ts` | `sub` group、`create --parent`、`new --parent`（env で子 process へ）、text 出力 |
| 起票の配線 | `core/service/terminal.ts`, `core/terminal/terminal-launch.ts`, `core/environment.ts`, `core/workflow/issue-create-prompt.ts` | [6.5](#65-new-sub-issue-の配線) の 5〜9 と prompt への親の明示 |
| Web | `web/src/api/types.ts`, `api/client.ts`, `queries/keys.ts`, `queries/issues.ts` | 型導出、`launchTerminal` の `parentIssue`、`queryKeys.subIssues`（`issues` 配下）、`useSubIssues` |
| Web | `components/dashboard-rows.tsx`, `issue-list.tsx`, `issue-detail.tsx`, `create-issue-button.tsx`, `terminal-controller.tsx` | disclosure、入れ子描画、`SubIssueSection`、breadcrumb、`New sub issue` の `parentIssue` prop |
| docs | `docs/command-transaction-boundaries.ja.md` | 新 procedure 4 行を inventory に追加 |

**データ**: 既存行は無変更（backfill なし）。新列は NULL 既定。
**互換性**: 旧 `lh` / 旧 Web は未知の列とフィールドを無視して従来どおり動く。

---

## 9. 検証方針

実装後に green にできる粒度で書く。すべて既存の配置規約（`<module>.test.ts` を隣に置く）に従う。

**core / unit**

- `core/issue-hierarchy.test.ts` — I1〜I7 のそれぞれについて拒否と許可。祖先配列と subtree の高さ
  だけを与える純粋 test。深さは境界を必ず突く: 深さ 2 の親への attach は成功、深さ 3 の親への
  attach は `parent_too_deep`、深さ 2 の親に高さ 2 の子を attach は `child_subtree_too_tall`、
  深さ 1 の親に高さ 2 の子は成功。`canHaveSubIssues` が depth 1/2 で true、3 で false。
- `core/store.test.ts`（既存 file に追記。`core/store/` 配下に新規 test は作らない — 現存するのは
  `jobs.test.ts` だけで、store helper の振る舞いはこの file が押さえている）— attach で `ordinal` が
  採番される、`listSubIssues` の並びが `(ordinal, id)`、detach で 2 列が NULL になる、
  `subIssueSummariesByParent` の open/closed 集計、`rootsOnly` が子を除く、
  `subtreeHeight` が 3 段の木で 3 を返し `limit` 超過で例外になる。
- `core/issues-service.test.ts` — `create --parent` の workspace 継承、深さ 3 の issue への
  `create --parent` が 422、根以外の workspace 変更が 422、根の変更が subtree へ cascade、
  reorder の順列検証、循環 attach が 422、4 段になる attach が 422。
  加えて `issues.list` が **`state` を open / closed / all のいずれにしても子を返さない**こと。
  状態 filter と階層が直交していることの回帰 test で、平坦一覧が裏口から戻るのを防ぐ。
- `core/migrations.test.ts` — 既存の「新規 DB と migration 済み DB の schema 一致」で列と index を担保。
  既存 issue が migration 後に根として扱われることを 1 case 追加。
- `core/serialize.test.ts` — 新フィールドの有無（子なしでは `sub_issue_summary` を省く、
  `sub_issues` の子が自分の `sub_issues` を持たない、`ancestors` が根始まりで最大 2 要素、
  `depth` が `ancestors.length + 1` と一致）。
- `core/service/transaction-boundaries.test.ts` — attach / detach / reorder の event 挿入を
  失敗注入し、親子の列変更が残らないこと。
- **検証の読みが transaction の内側にあること**（[3.3](#33-不変条件)）は、実際の競合を起こす test では
  担保しない。2 process を並べて狙った瞬間に commit させる test は不安定で、得るものより維持費が
  高い。代わりに **PR review の確認項目**とする: attach / detach / `create --parent` /
  workspace cascade の 4 つで、祖先・子孫・高さの読みが `db.transaction` の callback の中にあること。
  この 1 行を該当 procedure のコメントにも残し、後から外へ出す変更が目に留まるようにする。

**integration（`npm run test:integration`）**

- sub issue から workflow を開始したとき、PR の base が木の workspace branch になること
  （`dev.openPr` の base 解決が親子と独立であることの確認）。実 git が要るのでこちらに置く。

**Web（`npm run test:web`）**

- `issue-list.test.tsx` — 既定で子が描画されない、chip クリックで `pageData/subIssues` が
  1 回だけ呼ばれる、2 段目の子がさらに展開できる、3 段目の行に disclosure が出ない、
  loading / error / 壊れたデータの badge。
- `issue-detail.test.tsx` — `SubIssueSection` が `IssueRow` を描く、breadcrumb が祖先を出す、
  子行から `Start workflow` が押せる、`depth === 3` の issue に `New sub issue` が出ない、
  truncate 表示。
- `create-issue-button.test.tsx`（既存）— `parentIssue` を渡したとき `launchTerminal` の引数に
  それが載ること。この test は `useTerminalLauncher` を mock して引数を検証する形なので、
  [6.5](#65-new-sub-issue-の配線) の 1 段目を押さえる。5〜8 段は既存 file への追記で足りる:
  `core/terminal/terminal-launch.test.ts`（組み立てた command に ` --parent <n>` が入る）、
  `cli/issue-new.test.ts`（spawn する env に `LOOPHUB_PARENT_ISSUE` が載る）、
  `cli/commands/issue.test.ts`（`create` が `--parent` 未指定でも env から親を読む）。
- 展開中の子一覧が、**子自身の `issue.closed`** で refetch されること（[4.4](#44-event) の key 配置の
  回帰 test）。狭い key に戻す変更をここで落とす。`pull_request.*` は `event-keys.ts` が repo 全体の
  prefix を積むのでどちらの key でも通ってしまう。guard にならないので test 項目にしない。
- `web/src/api/rpc-mock.ts` に `pageData/subIssues` の fixture を追加。

**契約 / 静的**

- `npm run contract` の再生成差分が commit に含まれること。
- `npm run typecheck` / `npm run lint`。

---

## 10. 実装分割案

スライス単位の並びを以下に示す。**着手のためのタスク分解（1 タスク = 1 PR = 1 issue の粒度、
触る file・手順・完了条件・test・落とし穴つき）は
[`sub-issues-implementation-plan.ja.md`](./sub-issues-implementation-plan.ja.md) にある。**

| スライス | 内容 | 完了条件 |
|---|---|---|
| S1 | schema + migration + store + `core/issue-hierarchy.ts` | 既存 test が green、新 unit test が通る。UI 変化なし |
| S2 | service procedure（attach / detach / reorder / create --parent / workspace cascade）+ CLI `lh issue sub` / `lh issue create --parent` | CLI だけで階層を作って壊せる。transaction boundary doc 更新 |
| S3 | wire + `issues.list` の既定 roots + detail の `ancestors` / `sub_issues` + RPC + contract 再生成 | `lh issue view --json` と RPC が階層を返す |
| S4 | Web: issue 詳細の `SubIssueSection` と breadcrumb + **[6.5](#65-new-sub-issue-の配線) の起票配線 9 段**（`lh issue new --parent` と env、`terminal/launch` の `parentIssue`、prompt への親の明示を含む） | 詳細画面で子が一覧行 UI として見え、`New sub issue` から起票でき、workflow が開始できる |
| S5 | Web: repo トップの折りたたみサマリーと入れ子展開 | AC 4 を満たす |
| S6（後続） | Web からの attach / detach / drag reorder | 別 issue。v1 の受け入れ条件には含めない |

S1〜S3 は UI に出ないので、途中で止めても既存挙動は壊れない。S5 まで到達して初めて
issue #229 の受け入れ条件が全部埋まる。

S4 は起票配線を含むため、5 つのうち最も広く（web / core / cli の 3 層）触る。表示だけでも AC は
満たせるが、D9 が v1 に含めると宣言している以上、配線を落としたままにはしない。

実装計画のタスク（P1〜P9）との対応: S1 = P1 + P2、S2 = P3 + P4 + P5、S3 = P6、S4 = P7 + P8、
S5 = P9、S6 = 後続。

---

## 11. リスクと未解決の論点

**リスク**

| リスク | 影響 | 緩和 |
|---|---|---|
| 一覧が根のみになったことに気付かず「issue が消えた」と誤解される | 運用の混乱 | 行の `sub k/n` chip が子の存在を示し、`lh issue list` の footer が `lh issue sub list <n>` を案内する。migration 直後は全件が根なので実害は出ない |
| 展開で request が積み上がる | トップ画面の負荷 | 展開は利用者の明示操作、1 展開 = 1 request、既定は折りたたみ。深さ上限 3 により 1 つの根の下で起きうる展開は高々 2 段 |
| 3 段では足りない分解が出てくる | 木にできない作業が別 issue 群として散る | まずは 3 段で運用する。定数 1 つの変更で緩められるが、D10 のとおり深さ由来の例外規則が UI に戻ってくるため、緩める判断は計測を伴って行う（未解決 6） |
| 親を閉じても子が open のまま残る（D7） | 取り残し | 親行と詳細の `sub k/n` に残数が出る。将来 Notification Center の signal 候補 |
| `ancestors` / cascade の recursive CTE が壊れたデータで走り続ける | 応答が返らない | I7 の `MAX_ISSUE_DEPTH` 段で打ち切り、可視のエラーにする |
| 一覧 query の述語追加で index が効かなくなる | 一覧の劣化 | 既存 `idx_issues_repo_state` は `(repo_id, state)`。`parent_issue_id IS NULL` は選択後の述語で、ページは既に有界。劣化が観測されたら `(repo_id, parent_issue_id, state)` の複合 index を検討する |

**未解決（実装前に決めたい / 実装しながら決めてよい）**

1. **親の close と子の close** — D7 では連鎖しない。運用してみて「親を閉じたら子も閉じたい」が
   多いようなら、`lh issue close --with-sub-issues` のような明示 opt-in を足す（既定は変えない）。
2. **`MAX_ISSUE_DETAIL_SUB_ISSUES` の値** — 暫定 50。実運用の分解粒度を見てから決めてよい。
3. **`sub_issue_summary` を子孫全体の集計にするか** — 本設計では直接の子のみ。孫まで数えたくなる
   場面（親から全体の進捗を見る）はありうる。深さが 3 に固定されたことで集計は「2 段ぶんの
   join」で書けるようになり、recursive CTE を避けられる。要求が出たら eager のまま拡張できる
   見込みだが、一覧 query を 1 本増やす判断になるので、実際に欲しくなってから決める。
4. **workspace 変更が根からのみという制約の強さ** — 子だけを別 workspace へ移したい要求が出たら、
   「detach してから移す」で足りるか、`--detach-and-move` のような複合操作が要るかを再検討する。
5. **cross-repo の親子** — Non-goals。必要になったら `parent_issue_id` の FK は既に repo を跨げるので、
   不変条件 I2 の緩和と UI の repo chip 対応だけで拡張できる余地は残してある。
6. **深さ上限 3 の再評価** — 実運用で「3 段に収まらなかった分解」がどれだけ出たかを見てから判断する。
   計測は attach / create の 422 のうち `parent_too_deep` / `child_subtree_too_tall` が占める割合で
   足りる。緩めるときに schema は変わらない（`MAX_ISSUE_DEPTH` と UI のインデント規則だけ）。
