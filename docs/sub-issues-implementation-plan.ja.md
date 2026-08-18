# Sub issue 実装計画（タスク分解）

[`sub-issues-design.ja.md`](./sub-issues-design.ja.md) を実装するためのタスク分解。
**1 タスク = 1 PR = 後で 1 issue**の粒度で 9 本に切ってある。基準は「その設計を書いた人に
質問しなくても着手できる」こと。各タスクに、触る file、番号付きの手順、完了条件、test、依存、
落とし穴、そして大きくなったときの割り方を書く。

設計上の「なぜ」は本書に書かない。判断の根拠が要るときは設計書の該当節を読むこと。本書は
「何を、どこに、どの順で書くか」だけを持つ。

> **この時点では issue を起票していない。** 本書は起票前のバックログであり、順序と粒度の合意を
> 取るためのもの。起票するときは、各タスクの「目的 / 完了条件 / test」がそのまま issue の
> body と acceptance criteria になり、「手順」がそのまま作業の目次になる。

---

## 0. 作業の共通ルール

すべてのタスクに共通で適用する。各タスクの完了条件では繰り返さない。

- **1 タスク 1 PR。** 設計書の該当節を PR body に引用し、範囲外の改善を混ぜない。
- **green で終わる**: `npm test`（root fast + Web）、`npm run typecheck`、`npm run lint`。
  git を実際に使う test を足したときだけ `npm run test:integration` も回す。
- **AGENTS.md の分担を守る**: 判断は `core/`、`cli/` は flag 解析と表示だけ。DB を変える
  service procedure は state 変更と event を同じ `db.transaction` に入れ、git / spawn / HTTP は
  その外に置く（`docs/command-transaction-boundaries.ja.md`）。
- **test は隣に置く**: `<module>.test.ts`。DB を使う test は `LOOPHUB_HOME` / `LOOPHUB_DB` を
  設定してから core を dynamic import する（AGENTS.md の Tests 節）。
- **コメントは周囲の密度に合わせる。** 既存 file は「なぜそう書いたか」を書く文化なので、
  非自明な判断（不変条件、上限、event の選択）には理由を 1〜2 行添える。
- 用語は設計書に揃える: 根 / 子 / 孫、深さ（根 = 1）、実効 workspace、attach / detach。

---

## 1. タスク一覧

| # | タスク | 層 | 依存 | 目安 |
|---|---|---|---|---|
| P1 | schema・migration・store helper | core/db, core/store | — | M |
| P2 | `core/issue-hierarchy.ts`（純粋判定） | core | — | S |
| P3 | service: attach / detach / reorder | core/service | P1 P2 | M |
| P4 | service: 親つき作成・workspace cascade・一覧を根のみに | core/service | P1 P2 P3 | L |
| P5 | CLI: `lh issue sub` group と表示 | cli | P3 P4 | M |
| P6 | wire・pageData・JSON-RPC 契約 | core, web/server | P4 | L |
| P7 | Web: 型と query、issue 詳細の sub issue 節 | web | P6 | M |
| P8 | `New sub issue` の起票配線（9 段） | core, cli, web | P4 P7 | L |
| P9 | Web: 一覧の chip と展開・入れ子描画 | web | P7 | L |

目安は junior が 1 人で着手した場合の粗い目盛り。**S** = 半日、**M** = 1 日、**L** = 2 日。

**依存の形**

```
P1 ─┬─ P3 ── P4 ─┬─ P5
P2 ─┘            └─ P6 ── P7 ─┬─ P8   （P8 は P4 にも依存）
                              └─ P9
```

P2 は DB に触らないので P1 と同時に始められる。P5 は P6 以降と独立に進む。
Web の 2 本（P8 / P9）は P7 が終わってから。

---

## 2. 各タスク

### P1. schema・migration・store helper

**目的**: 親子 2 列を足し、階層を読み書きする SQL を store に閉じ込める。判断は持たせない。

**触る file**: `core/db.ts`、`core/migrations.ts`、`core/store/issues.ts`、
`core/migrations.test.ts`、`core/store.test.ts`

**手順**

1. **schema**: `core/db.ts` の `SCHEMA` にある `issues` に 2 列と index を足す。

   ```sql
     parent_issue_id   INTEGER REFERENCES issues(id),
     sub_issue_ordinal INTEGER,
   -- issues の CREATE TABLE の直後に
   CREATE INDEX IF NOT EXISTS idx_issues_parent
     ON issues(parent_issue_id, sub_issue_ordinal);
   ```

2. **migration**: `npm run migration:new -- issues-parent-issue-id` で ID を作り、`MIGRATIONS` の
   **末尾**に 3 entry（`addColumn` × 2、index は `sql`）。name は
   `issues-parent-issue-id` / `issues-sub-issue-ordinal` / `issues-parent-index`。
3. **行の型**: `IssueRow` に `parent_issue_id: number | null` と
   `sub_issue_ordinal: number | null`。
4. **読み取り helper**

   | helper | 実装 |
   |---|---|
   | `listIssues(repoId, kind, state, sort, opts?: { rootsOnly?: boolean })` | 既存の条件配列に `parent_issue_id IS NULL` を足すだけ。signature の後方互換を保つ |
   | `listSubIssues(parentId): IssueRow[]` | `WHERE parent_issue_id = ? ORDER BY sub_issue_ordinal, id` |
   | `subIssueSummariesByParent(parentIds): Map<number, {total, open, closed}>` | `WHERE parent_issue_id IN (...) GROUP BY parent_issue_id`。空配列なら空 Map を即返す（`labelsByIssue` などの既存 batch helper と同じ形） |
   | `listAncestorRows(issueId, limit): IssueRow[]` | 親方向の recursive CTE。子に近い側から返す |
   | `listDescendantIds(issueId, limit): number[]` | 子孫方向の recursive CTE |
   | `subtreeHeight(issueId, limit): number` | 深さ付き CTE の `MAX(depth)`。葉は 1 |

5. **書き込み helper**
   - `nextSubIssueOrdinal(parentId)` — `COALESCE(MAX(sub_issue_ordinal), 0) + 1`
     （`addAcceptanceCriterion` の写し）。
   - `setIssueParent(childId, parentId | null, ordinal | null)` — 2 列を 1 statement で書き、
     `updated_at` も更新する。
   - `reorderSubIssues(parentId, orderedChildIds)` — `reorderAcceptanceCriteria` の写し。
     順列であることの検証は呼び出し側（P3）。

**完了条件 / test**

- `core/migrations.test.ts`: 新規 DB と migration 済み DB の schema が一致（既存の比較 test）。
  既存 issue が migration 後に根になる case を 1 つ追加。
- `core/store.test.ts`（既存 file に追記。`core/store/` 配下に新しい test file は作らない）:
  `listSubIssues` の並びが `(ordinal, id)` / `subIssueSummariesByParent` の open・closed 集計と
  空入力 / `rootsOnly` が子を除き、省略時は従来どおり / attach 相当で `ordinal` が 1,2,3 と伸びる /
  detach 相当で 2 列が NULL / `reorderSubIssues` 後の並び / `subtreeHeight` が 3 段の木で 3、
  葉で 1、`limit` 超過で例外。

**落とし穴**

- **既存 migration の ID・本文・並びは絶対に変えない。** append のみ。列追加は必ず `addColumn`
  （`PRAGMA table_info` guard 付き）で、`sql()` は idempotent ではない。
- SQLite は `ADD COLUMN ... REFERENCES`（default NULL）を許すが `NOT NULL` / `UNIQUE` は不可。
  CHECK 制約は table rebuild になるので置かない（設計書 3.2）。
- backfill は書かない。NULL がそのまま「根」を意味する。
- 走査系（`listAncestorRows` / `listDescendantIds` / `subtreeHeight`）は必ず `limit` を取り、
  超過したら**黙って切らずに例外**にする（設計書 3.3 の I7）。
- 欠番は埋めない。`parent_issue_id` と `sub_issue_ordinal` は常に一緒に書く。

**大きくなったら**: 手順 1〜3（schema）と 4〜5（helper）で 2 PR に割れる。schema だけの PR は
それ自体で green になる。

---

### P2. `core/issue-hierarchy.ts`（純粋判定）

**目的**: 親子関係の不変条件を、DB も git も触らない関数として書く。

**触る file**: `core/issue-hierarchy.ts`（新規）、`core/issue-hierarchy.test.ts`（新規）

**手順**

`core/worktree-prune.ts` を手本にする（純粋な判定モジュールの先例）。

```ts
export const MAX_ISSUE_DEPTH = 3;

export interface IssueFacts {
  id: number;
  number: number;
  repoId: number;
  kind: "issue" | "pull";
  targetBranch: string | null;
}

export type AttachRejection =
  | { kind: "not_an_issue" } | { kind: "cross_repo" } | { kind: "self" }
  | { kind: "cycle"; ancestorNumber: number }
  | { kind: "workspace_mismatch"; parentWorkspace: string; childWorkspace: string }
  | { kind: "parent_too_deep"; parentDepth: number }
  | { kind: "child_subtree_too_tall"; parentDepth: number; childHeight: number };

export function effectiveWorkspace(targetBranch: string | null, defaultBranch: string): string;
export function canHaveSubIssues(depth: number): boolean;      // depth < MAX_ISSUE_DEPTH
export function rejectAttach(input: {
  child: IssueFacts;
  parent: IssueFacts;
  parentAncestorNumbers: number[];  // 親から根へ。length + 1 が親の深さ
  childSubtreeHeight: number;
  defaultBranch: string;
}): AttachRejection | null;
```

判定順は設計書 3.3 の I1 → I6（安い順・原因が分かりやすい順）。

**完了条件 / test**（DB 不要な純粋 test）

- I1〜I6 それぞれの拒否と、正常系の許可。
- 深さの境界を必ず突く: 深さ 2 の親 + 高さ 1 の子 = 成功 / 深さ 3 の親 = `parent_too_deep` /
  深さ 2 の親 + 高さ 2 の子 = `child_subtree_too_tall` / 深さ 1 の親 + 高さ 2 の子 = 成功。
- `canHaveSubIssues` が depth 1, 2 で true、3 で false。
- `effectiveWorkspace(null, "main") === "main"`。

**落とし穴**

- `3` という数値をこの file の外に書かない。UI も CLI も service も、深さの判断は
  `MAX_ISSUE_DEPTH` / `canHaveSubIssues` / `rejectAttach` 経由にする。
- 拒否理由は「どちらが超えたか」を持たせる。メッセージ整形は service の仕事。

---

### P3. service: attach / detach / reorder

**目的**: 親子関係を張る / 外す / 並べ替える procedure を、検証・event・transaction 込みで用意する。

**触る file**: `core/service/issues.ts`、`core/issues-service.test.ts`、
`core/service/transaction-boundaries.test.ts`、`docs/command-transaction-boundaries.ja.md`

**手順**

1. **rejection → `ServiceError` の写像**を 1 か所に置く（`AttachRejection` の各 kind から
   422 のメッセージへ）。以降の procedure と P4 がこれを共有する。
2. `issues.attachSubIssue(repo, parentNumber, childNumber, sessionId?)`
   - **`db.transaction` の callback の中で**、行を読む（`issueOr404` × 2）→
     `listAncestorRows` / `subtreeHeight` を引く → `rejectAttach` に渡す → rejection を 422 に写す
     → `setIssueParent(child, parent, nextSubIssueOrdinal(parent))` → **子・新しい親・
     （付け替えなら）元の親**それぞれの `issue.updated`。
   - 検証を callback の外に出さない（理由は下の落とし穴）。
3. `issues.detachSubIssue(repo, childNumber, sessionId?)`
   - transaction 内で、根かどうかを確認（根なら 422 `issue #n has no parent`）→
     `setIssueParent(child, null, null)` → 子・元の親の `issue.updated`。
4. `issues.reorderSubIssues(repo, parentNumber, orderedChildNumbers)`
   - **ここだけは検証が transaction の外でよい**（`acReorder` と同じ形）。「その親の子を
     過不足なく 1 回ずつ」でなければ 422。
   - transaction 内で `reorderSubIssues` と親の `issue.updated`。
5. `docs/command-transaction-boundaries.ja.md` の procedure 一覧に 3 行足す。

**完了条件 / test**

- 正常系: attach → `listSubIssues` に現れ、detach → 根に戻る。reorder で並びが変わる。
- 拒否: 自己参照 / 循環 / 別 repo / PR / workspace 不一致 / 4 段になる attach / 部分指定の
  reorder、それぞれ 422。
- `transaction-boundaries.test.ts`: `issue.updated` の insert を失敗注入したとき
  `parent_issue_id` が変わっていないこと。

**落とし穴**

- 新しい event type を作らない。`issue.updated` を関係する issue の数だけ発火する
  （設計書 4.4）。payload は `{ number }`。
- public な参照は issue **number**。内部 id を引数にも戻り値にも出さない。
- **検証の読みを `db.transaction` の外に出さない**（設計書 3.3 / D12）。同 file の `acReorder` は
  検証を外に置いているので、それを真似すると間違える。`BEGIN IMMEDIATE` が直列化するのは
  writer 同士だけで、「読んで検証してから BEGIN して書く」形だと 2 つの process が同じ
  pre-commit 状態を見てから順に commit でき、`#12 → #30` と `#30 → #12` の同時 attach で循環が、
  深さ 2 の親への同時 attach で 4 段の木ができる。callback の中で読めば write lock 取得後の
  状態を見るので、check-then-act が 1 単位になる。
  この理由は procedure のコメントにも 1 行残す（後から外へ出す変更が目に留まるように）。
- transaction の callback に入れてよいのは DB 操作だけ。git / spawn / HTTP / filesystem は従来どおり外。

---

### P4. service: 親つき作成・workspace cascade・一覧を根のみに

**目的**: 既存の issue 操作を階層に対応させる。ここまでで CLI から階層を一通り扱える状態になる。

**触る file**: `core/service/issues.ts`、`core/service/dashboard.ts`、`core/issues-service.test.ts`

**手順**

1. **`issues.create` に `parent?: number`**
   - branch 検証（`resolveTargetBranch`、git を叩く）は従来どおり transaction の**前**に済ませる。
   - **既存の create transaction の中で**、親を読み、`canHaveSubIssues(親の深さ)` と
     kind / repo / workspace を検証（P3 の写像を再利用。深さは `listAncestorRows` から）→
     issue を作り → `setIssueParent(child, parent, nextOrdinal)` →
     `issue.opened`（子）と `issue.updated`（親）。
   - `workspace` / `target_branch` が明示され、親の実効 workspace と食い違えば 422。
     **未指定なら親の `target_branch` を継承**する。
2. **`issues.update` の workspace cascade**
   - `workspace` / `target_branch` を変えるとき、**transaction の中で**対象が根かどうかを確認し、
     根でなければ 422（`change the workspace on the root issue #n`）。
   - 根なら `listDescendantIds`（これも transaction 内）で得た子孫の `target_branch` も
     同じ transaction で書き換え、変更した issue と各子孫に `issue.updated` を出す。
3. **一覧を根のみに**
   - `issues.list` が `S.listIssues(..., { rootsOnly: true })` を呼ぶ。**param は増やさない**
     （平坦一覧の選択肢は作らない。設計書 5.2）。
   - `core/service/dashboard.ts` の `S.listIssues(r.id, "issue", "open")` にも `rootsOnly: true`。
4. **`issues.listSubIssues(repo, number)`** を足す。直接の子を、一覧と同じ enrich
   （`issueListItemsJSON` と同じ selection map）で返す。

**完了条件 / test**

- 親が workspace `ws-a` のとき、子の `target_branch` が `ws-a` になる。
- 深さ 3 の issue を親に指定した create が 422。明示 workspace が親と違えば 422。
- 3 段の木の根を `ws-b` に変えると子と孫も `ws-b`。子の workspace 直接変更は 422。
- `state` が open / closed / **all** のいずれでも `issues.list` が子を返さない
  （状態 filter と階層が直交していることの回帰 test。平坦一覧が裏口から戻るのを防ぐ）。
- `listSubIssues` が `(ordinal, id)` 順で、各行に linked PR の enrich つきで返る。

**落とし穴**

- branch 検証（`resolveTargetBranch`）は git を叩くので、既存どおり transaction の**外**で
  済ませてから DB 区間に入る。**階層の検証（深さ・kind・repo・workspace 一致）は逆に
  transaction の内側**（P3 の落とし穴と同じ理由。設計書 D12）。「検証はぜんぶ外」と
  まとめて動かさないこと。
- `issues.list` は `kind: "pull"` でも呼ばれる。PR は常に根なので結果は変わらないが、
  条件を kind で分岐させない。
- cascade の event 数は子孫の数だけ増える。上限は付けない（設計書 3.4）。

**大きくなったら**: 手順 3〜4（一覧まわり）を別 PR にできる。1〜2 とは触る箇所がほぼ重ならない。

---

### P5. CLI: `lh issue sub` group と表示

**目的**: CLI だけで階層を作り、崩し、読めるようにする。

**触る file**: `cli/commands/issue.ts`、`cli/commands/issue.test.ts`

**手順**

1. `lh issue ac` の subcommand 分岐（同 file）と同じ形で足す。

   ```
   lh issue sub list <parent>
   lh issue sub add <parent> <child>
   lh issue sub remove <child>
   lh issue sub reorder <parent> --order 31,12,44
   lh issue create --parent <n>
   ```

   引数不足は `fail("usage: ...")`（`ac` の usage 行が手本）。
2. `lh issue list` の各行末に `sub 2/5`（closed/total）。sub issue を持つ行が 1 つでもあれば、
   末尾に `use 'lh issue sub list <n>' to see sub issues` を 1 行。
3. `lh issue view` の text 出力に、親がある場合の `Parent: #12 › #30` と、子がある場合の
   `Sub issues` 節（`#n [state] title`）。

**完了条件 / test**: 各 subcommand が service を正しい引数で呼ぶ。子を持つ / 持たない issue で
text 出力が変わる。深さ超過などの 422 は core のメッセージがそのまま stderr に出る。

**落とし穴**

- CLI で深さを数え直したり、上限を回避する再試行をしたりしない。
- `--json` の出力形は変えない（wire をそのまま出す既存動作を維持）。

---

### P6. wire・pageData・JSON-RPC 契約

**目的**: Web が 1 request で必要な集合を得られるところまで通す。

**触る file**: `core/serialize.ts`、`core/serialize-status.ts`、`core/store/issues.ts`、
`core/service/page-data.ts`、`web/server/contract.ts`、`docs/rpc-contract.json`、
`core/serialize.test.ts`、`core/service/page-data.test.ts`

**手順**

1. **wire 型**: `core/serialize.ts` に `SubIssueSummaryWire`、`IssueRefSummaryWire` を足し、
   `IssueWire` に `depth?` / `sub_issue_ordinal?` / `sub_issue_summary?` / `ancestors?` /
   `sub_issues?` / `sub_issues_truncated?`（設計書 5.1 のコメントごと）。
   `IssueDetailPageWire` に `workflow_runs` を足す。
2. **上限**: `core/store/issues.ts` に `MAX_ISSUE_DETAIL_SUB_ISSUES = 50`
   （`MAX_ISSUE_DETAIL_PULLS` が手本）。
3. **載せ込み**（`core/serialize-status.ts`）
   - `IssueListSelection` に `subIssueSummariesByParent` を足し、`issueListItemsJSON` が各行に
     `sub_issue_summary` と `depth: 1` を載せる。1 件版 `issueListItemJSON`（dashboard 用）も同様。
   - `issueDetailJSON` が `ancestors`（根始まり）と `sub_issues`（直接の子、上限で truncate）を載せる。
4. **pageData**: `pageData.subIssues(repo, number)` を足し、
   `{ issues, truncated, workflow_runs }` を返す（`workflow_runs` は `pageData.issueList` と
   同じく `workflowRuns.statesForPulls` から）。**子は detail と同じ
   `MAX_ISSUE_DETAIL_SUB_ISSUES` で truncate する** — 深さは有界でも幅は無制限なので、
   この lazy 経路に上限が無いと子 100 件の親を 1 回展開しただけで、一覧が避けたはずの
   git fan-out をそのまま払う（設計書 5.2）。
   `pageData.issueDetail` の戻りにも `workflow_runs` を足す。
5. **契約**: `web/server/contract.ts` に method を足す。

   | method | params |
   |---|---|
   | `pageData/subIssues` | `{ repo, number }` |
   | `issues/sub/attach` | `{ repo, parent, child, session_id }` |
   | `issues/sub/detach` | `{ repo, child, session_id }` |
   | `issues/sub/reorder` | `{ repo, parent, order: number[], session_id }` |

   `issues/create` に `parent: positiveInt` を足す。`issues/list` は**変更しない**。
6. `npm run contract` を実行し、`docs/rpc-contract.json` の差分を同じ commit に含める。

**完了条件 / test**

- 子を持たない issue では `sub_issue_summary` を**省く**（`acceptance_criteria` と同じ扱い）。
- `sub_issues` に入る子は自分の `sub_issues` を持たない（1 応答 = 1 階層）。
- `ancestors` が根始まりで最大 2 要素、`depth === ancestors.length + 1`。
- 上限超過で `sub_issues_truncated: true`。
- `pageData/subIssues` が子と run state を 1 回で返し、上限超過で `truncated: true` を返す。
  contract の再生成差分が入っている。

**落とし穴**

- `core/serialize.ts` は同期・`node:fs` / `core/git.ts` 非依存を保つ。git や worktree に依存する
  載せ込みは `core/serialize-status.ts` 側（AGENTS.md の Wire types 節）。
- 一覧の子サマリーは **1 回の `GROUP BY` query**で取る。行ごとに引かない。
- run state は行ごとに要求しない。1 event で全行が invalidate される問題を避けるための seed
  である（`docs/issue-list-workflow-run-state.ja.md`）。

**大きくなったら**: 手順 1〜3（serialize）と 4〜6（pageData と契約）で 2 PR に割れる。

---

### P7. Web: 型と query、issue 詳細の sub issue 節

**目的**: Web 側の data 取得口を用意し、詳細画面で直接の子を一覧と同じ行 UI で見せる。

**触る file**: `web/src/api/types.ts`、`web/src/api/client.ts`、`web/src/queries/keys.ts`、
`web/src/queries/issues.ts`、`web/src/api/rpc-mock.ts`、`web/src/components/issue-detail.tsx`、
`web/src/components/issue-detail.test.tsx`

**手順**

1. **型**: `types.ts` は `core/serialize.ts` から type-only import で導出する（手書きしない）。
2. **client**: `getSubIssuesPage(owner, repo, number)`。
3. **query key**（`keys.ts`）

   ```ts
   subIssues: (full: string, number: number) =>
     [...queryKeys.issues(full), "sub", number] as const,
   ```

   **`queryKeys.issue(full, number)` 配下に置かない。** 理由は設計書 4.4。
4. **hook**: `queries/issues.ts` に `useSubIssues(owner, repo, number, enabled)`。
   `rpc-mock.ts` に `pageData/subIssues` の routing を足す（`pageData/issueList` の
   既存 special case が手本）。
5. **詳細画面**: `IssueHeader` → `LinkedPullSummary` → **`SubIssueSection`** →
   `IssueHerdrSection` の順で挿入。`SubIssueSection` は `pageData/issueDetail` が返した
   `sub_issues` を `IssueRow`（`web/src/components/dashboard-rows.tsx`）で描く。
   **独自の行 component を作らない。** 子 0 件なら節ごと出さない。`sub_issues_truncated` なら
   末尾に `Showing first 50 sub issues`。
6. **breadcrumb**: `IssueHeader` の badge 行に `ancestors` から `#12 › #30`（各要素が Link）。

**完了条件 / test**: 子が `IssueRow` として描かれる / breadcrumb が出る / 子行から
`Start workflow` が押せる / truncate 表示 / hook が `enabled: false` で request を出さない。

**落とし穴**

- `event-keys.ts` は**触らない**。key を `issues` 配下に置いたことで、既存の `issue.*` /
  `pull_request.*` の invalidation にそのまま乗る。
- 子行の mini tracker は P6 で seed 済み。行ごとに run state を取りに行かない。

---

### P8. `New sub issue` の起票配線（9 段）

**目的**: 詳細画面の button から親 issue 番号を、起票する agent session まで運ぶ。

**触る file**: `core/environment.ts`、`cli/commands/issue.ts`、
`core/terminal/terminal-launch.ts`、`core/workflow/issue-create-prompt.ts`、
`core/service/terminal.ts`、`web/server/contract.ts`、`docs/rpc-contract.json`、
`web/src/api/client.ts`、`web/src/components/terminal-controller.tsx`、
`web/src/components/create-issue-button.tsx`、`web/src/components/issue-detail.tsx`、
`cli/issue-new.test.ts`、`cli/commands/issue.test.ts`、
`core/terminal/terminal-launch.test.ts`、`web/src/components/create-issue-button.test.tsx`

**手順**（設計書 6.5 の 9 段。下（core / CLI）から上（Web）へ通すと、各段で test を green にできる）

1. `core/environment.ts` に `ENV_PARENT_ISSUE = "LOOPHUB_PARENT_ISSUE"`。
2. `lh issue new` に `--parent` を足し、spawn する runtime の env に載せる
   （同 file の `LOOPHUB_WORKSPACE` の扱いが手本）。
3. `lh issue create` が `flags.parent ?? process.env[ENV_PARENT_ISSUE]` を読む
   （`--target-branch` の env fallback と同じ形）。
4. `core/terminal/terminal-launch.ts` の `issue-create` 分岐に ` --parent <n>`（`shellArg` で escape）。
5. `issueCreatePrompt(language)` に親 issue 番号の引数を足し、「`#<n>` の sub issue として、
   親の acceptance criteria に収まる粒度で起票する」の 1 文を加える。
   **呼び出し側は 2 つある**: `cli/commands/issue.ts` の `new`（`--prompt` 未指定時の fallback。
   この手順で直す）と `web/src/components/create-issue-button.tsx`（手順 8 で直す）。
6. `core/service/terminal.ts` が `issue-create` のときだけ `parentIssue` を下へ渡す
   （`targetBranch` と同じ扱い）。
7. `web/server/contract.ts` の `terminal/launch` params に `parentIssue: positiveInt`。
   `npm run contract` を再実行して差分を含める。
8. `web/src/api/client.ts` → `terminal-controller.tsx` の launch options →
   `create-issue-button.tsx` の `parentIssue?: number` prop → `launchTerminal` へ。
   button の副題は `in <branch>` に倣って `sub issue of #<n>`。
   **同 component が prompt も組み立てている**ので、`issueCreatePrompt(language, parentIssue)` に
   変える（手順 5 で足した引数を、ここで実際に渡す）。ここを飛ばすと Web 起点の起票では
   親が env にしか乗らず、手順 5 の意味が無くなる。
9. `SubIssueSection` の見出し右に `New sub issue` を置く。
   `canHaveSubIssues(issue.depth)` が false なら出さない。

**完了条件 / test**

- 組み立てた command に ` --parent <n>` が入る（`terminal-launch.test.ts`）。
- spawn する env に `LOOPHUB_PARENT_ISSUE` が載る（`cli/issue-new.test.ts`）。
- `lh issue create` が `--parent` 未指定でも env から親を読む（`cli/commands/issue.test.ts`）。
- `parentIssue` を渡すと `launchTerminal` の引数に載る（`create-issue-button.test.tsx`）。
- 深さ 3 の issue に button が出ない。

**落とし穴**

- **`CreateIssueButton` は issue を作らない。** 作るのは起動された session の中の
  `lh issue create` である。「button に prop を渡すだけ」では親は届かない。
- workspace は env だけで運ばれるが、**parent は prompt にも出す**。env だけだと agent が親を
  読まずに範囲のずれた子を起票しうる（設計書 6.5）。
- UI 側の深さ判定は案内にすぎない。最終的な拒否は core の 422（親が途中で移動しうる）。

**大きくなったら**: 手順 1〜5（core / CLI 側）と 6〜9（Web / terminal 側）で 2 PR に割れる。
前半だけでも `lh issue new --parent` として単体で使える。

---

### P9. Web: 一覧の chip と展開・入れ子描画

**目的**: repo トップから任意の親を展開し、3 段目まで辿れるようにする。

**触る file**: `web/src/components/dashboard-rows.tsx`、`web/src/components/issue-list.tsx`、
`web/src/components/issue-list.test.tsx`

**手順**

1. **行の表示**: `IssueRow` に、`sub_issue_summary.total > 0` のときだけ `#number` の左へ
   chevron と `sub k/n` chip を出す。深さ 3 の行には出さない。
   開閉は props（`expanded` / `onToggle`）で受け、状態は持たせない。
2. **展開状態**: `IssueList` に `Set<number>` を持たせる。URL には載せない。
3. **入れ子描画**: 展開された親の下に `useSubIssues` の結果を `IssueRow` で描く。
   インデントは 1 段 `pl-6`。子も同じ chip / disclosure を持つので描画は再帰。
4. **防御**: 再帰は path を持ち回り、同じ number が再登場したら再帰せず `階層が不正` badge を
   出して打ち切る。深さが `MAX_ISSUE_DEPTH` を超えた場合も同じ。
5. **状態表示**（設計書 6.3）: loading = 1 行のスケルトン + `Loader2` / error = 破線枠 + `Retry` /
   空 = `No sub issues` / 応答の `truncated` が真なら末尾に `Showing first 50 sub issues`。
   一覧全体は落とさない。
6. **workspace section**: 割り当ては根だけで決まる。子は常に親の直下に描く。

**完了条件 / test**

- 既定で子が描画されない。chip を押すと `pageData/subIssues` が 1 回だけ呼ばれる。
- 2 段目の子をさらに展開できる。3 段目の行には disclosure が出ない。
- **子自身の `issue.closed` で子一覧が refetch される**（key の置き場所の回帰 test。
  狭い key に戻す変更をここで落とす）。`pull_request.*` は `event-keys.ts` が repo 全体の
  prefix を積むのでどちらの key でも通ってしまう。guard にならないので test 項目にしない。
- loading / error / 壊れたデータの表示。

**落とし穴**

- `IssueRow` を import しているのは現状 `web/src/components/issue-list.tsx` だけ（call site は
  同 file の 2 箇所）で、そこに P7 の詳細画面が加わる。`dashboard-rows.tsx` の component 上の
  comment は「home / repo dashboard / issue 一覧で共有」と書いているが、これは今の call site とは
  合っていない（読むときに信用しないこと。今回の PR で直す対象でもない）。
  いずれにせよ props は**必須にせず optional で足す**。既存 2 箇所を触らずに済む。
- 展開状態は画面遷移で失われる。既定が折りたたみなので失われる情報はない、という判断
  （設計書 6.1）。URL param を足したくなっても、このタスクでは足さない。

**大きくなったら**: 手順 1（chip の表示だけ）を先に出せる。既存 4 画面への影響確認が主で、
展開の状態管理・再帰・event 追従とは壊し方が違う。

---

## 3. 並行作業の目安

- 2 人なら: A が P1 → P3 → P4、B が P2 →（P4 完了後）P6。合流点は P4。
  P5 は P4 の後、どちらが取ってもよい独立作業。
- 3 人目が入るなら P8 の前半（core / CLI 側の起票配線）は P4 さえ終われば独立して進む。
- Web の 2 本（P8 後半 / P9）は P7 が終わるまで着手しない。型が固まる前に UI を書くと、
  `types.ts` の手書きという禁じ手に流れやすい。

---

## 4. このバックログに入れていないもの

- **Web からの attach / detach / drag reorder**（設計書 D9、S6）。v1 の受け入れ条件外。
  RPC は P6 で用意済みなので、後から UI だけ足せる。
- 親を閉じたときの子の連鎖 close（設計書 D7 で「しない」と決めた）。
- 子孫全体を数えるサマリー、深さ上限の緩和、cross-repo の親子
  （設計書 11 章の未解決 3 / 6 / 5）。
