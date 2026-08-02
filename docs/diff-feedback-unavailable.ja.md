# Diff feedback の `unavailable` 調査

## 結論

- スクリーンショットの `unavailable` は投稿者の状態ではなく、diff conversation の保存済みアンカーについて現在位置を判定できていないことを表す `freshness` である。anchor が patch 上にないことを断定する値ではない。wire 上でも `freshness` は thread の属性で、message の `author` とは別である（`core/serialize.ts:410-417`, `core/serialize.ts:427-452`）。
- UI は投稿者名と anchor 情報を別要素にし、`current` 以外を location 側で `Diff anchor location unavailable | Diff anchor outdated` と表示する（`web/src/components/pull-diff-dialog.tsx:1679-1703`）。個々の message 行は投稿者名と comment ID だけを表示し、状態は表示しない（`web/src/components/pull-diff-dialog.tsx:1715-1721`）。
- 人間かエージェントかは `freshness` の判定材料ではない。diff feedback の schema は thread の `created_by` と message の `author` を文字列として保存し、別テーブルの location に `freshness` を保存する（`core/db.ts:229-258`, `core/db.ts:261-267`）。

## `unavailable` の意味と発生経路

- `freshness` の値域は `current | outdated | unavailable` であり、`outdated` だけが `deleted | modified | ambiguous` の理由を持つ（`core/serialize.ts:385-388`, `core/serialize.ts:447-452`）。保存済み location の検証でも、`unavailable` は `outdated_reason` と `resolved_anchor` をどちらも持たない組として扱われる（`core/service/diff-feedback.ts:407-419`, `core/service/diff-feedback.ts:444-449`）。
- 新規 thread は、作成時に検証した anchor を現在の commit pair の `current/inline` location として即時保存する。このため、投稿直後の再取得は worker の非同期 precompute を待たず `current` を返す（`core/service/diff-feedback.ts:834-900`, `core/service/diff-feedback.test.ts:119-145`）。
- `diffFeedback.list()` は現在の commit pair 用の保存済み location がない thread に `fallbackLocation()` を使う。fallback は `freshness: "unavailable"` と `resolved_anchor: null` を返す一方、保存済み anchor が現在の patch 上にあれば `placement: "inline"` を返せる（`core/service/diff-feedback.ts:484-496`, `core/service/diff-feedback.ts:677-690`）。この cache miss の組み合わせは service test でも検証されている（`core/service/diff-feedback.test.ts:321-338`）。
- 現在の base/head commit pair を得られない場合は `unavailable` になる（`core/service/diff-feedback.ts:171-187`）。元 commit のファイルが `ok` でない場合も `unavailable` になる。一方、現在 commit のファイルが `missing` なら `outdated/deleted` であり、それ以外の非 `ok` の場合だけ `unavailable` になる（`core/service/diff-feedback.ts:218-252`）。
- 元の patch 内で保存済み行範囲を解決できない場合も `unavailable` になる。`linesForAnchor` は範囲が patch 上に連続して存在しなければ `null` を返し（`core/diff-anchor.ts:62-84`）、thread 解決処理はその結果を `freshness: "unavailable"` と `placement: "historical"` に変換する（`core/service/diff-feedback.ts:312-332`）。
- `unavailable` でも conversation 自体は消えない。service test は `freshness: "unavailable"`, `placement: "historical"`, `resolved_anchor: null` と元 context の保持を検証し（`core/service/diff-feedback.test.ts:660-678`）、Web test は conversation 本文と Resolve 操作が引き続き表示されることを検証している（`web/src/components/pull-diff-dialog.test.tsx:2754-2811`）。人間の `unavailable/inline` fallback と agent の `outdated` について、投稿者名とは別に anchor freshness を表示する component test もある（`web/src/components/pull-diff-dialog.test.tsx:2815-2864`）。

## 人間投稿者とエージェント状態

- diff feedback は wire に author type を持たず、`me` と `unknown` を人間として `@human` に表示し、それ以外の session 名をそのまま表示する（`web/src/lib/comment-author.ts:10-13`, `web/src/lib/comment-author.ts:25-30`）。この振る舞いは人間の両 actor 名と agent session 名について unit test がある（`web/src/lib/comment-author.test.ts:24-33`）。
- 本物のエージェント状態は Herdr CLI の `agent_status` 由来であり、既知値は `working | blocked | done | idle` である（`core/terminal/herdr-status.ts:13-24`, `core/terminal/herdr-status.ts:73-99`）。値が欠落または文字列でない場合は空文字列にする（`core/terminal/herdr-status.ts:83-99`, `core/terminal/herdr-status.test.ts:238-254`）。
- Herdr 状態は `HerdrAgent` / PR worktree に対応づいた agent の属性として Web に投影され、投稿者や diff feedback message の属性にはならない（`core/terminal/herdr-status.ts:104-123`, `core/terminal/session-projection.ts:194-219`）。PR の agent details は `agent.status` を Status 行へ表示し、値ごとの色を適用する（`web/src/components/pull-herdr-section.tsx:16-29`, `web/src/components/pull-herdr-section.tsx:286-290`）。component test は `working | blocked | done | idle` を実際の details 表示へ入力して検証し（`web/src/components/pull-herdr-section.test.tsx:318-347`）、human diff thread にはこれらの agent status が表示されないことも検証する（`web/src/components/pull-diff-dialog.test.tsx:2842-2854`）。

## テスト（引用定義の存在確認）

引用定義の存在確認結果: **passed**。次の `rg` は引用対象の存在確認であり、runtime behavior の test 結果ではない。

```sh
rg -n 'DiffFeedbackFreshness|freshness: DiffFeedbackFreshness|author: string' core/serialize.ts
rg -n 'freshness: "current"|freshness: "unavailable"|linesForAnchor|upsertDiffFeedbackLocation' core/service/diff-feedback.ts core/diff-anchor.ts
rg -n 'thread\.freshness|diffFeedbackAuthor\(thread\.created_by\)|diffFeedbackAuthor\(message\.author\)' web/src/components/pull-diff-dialog.tsx
rg -n 'created_by|freshness|diff_feedback_messages|author +TEXT' core/db.ts
rg -n 'agent_status|known values: working \| blocked \| done \| idle' core/terminal/herdr-status.ts
rg -n 'label="Status"|statusTextClass|shows the valid .* agent status|queryByText\(agentStatus\)' web/src/components/pull-herdr-section.tsx web/src/components/pull-herdr-section.test.tsx web/src/components/pull-diff-dialog.test.tsx
rg -n 'stores its current location|shows orphaned conversations|inline unavailable fallback|freshness: "unavailable"|shows both human actor names|keeps an agent session name' web/src/components/pull-diff-dialog.test.tsx core/service/diff-feedback.test.ts web/src/lib/comment-author.test.ts
```
