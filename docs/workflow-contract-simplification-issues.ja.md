# Workflow contract 簡素化 — issue 分割

`docs/parent-contract-simplification.ja.md` / `docs/verify-execute-contract-simplification.ja.md` /
`docs/workflow-contracts-simplification.ja.html` の提案を、小さい vertical slice に分割したもの。
起票後に各行へ issue 番号を追記する。

調査で判明した追加事項: 言語節(「## 言語」)は contract ファイルではなく
`core/workflow/messages.ts` が合成時に挿入している。そのため言語節の 1 行化は独立した
小タスク(#0)として分離した(3 つの contract 簡素化とは別ファイルの変更)。

## 一覧

全 issue に label `contract-simplification` を付与済み。タイトル先頭の `[stage-n]` が作業順で、
同じ stage 内は並行可。全 issue の target は workspace `contract-simplification`
(main から分離。lh issue update --workspace で移動済み)。

| 順番 | Issue | 内容 | 依存 |
|------|-------|------|------|
| 1-1 | #1734 | 言語節を 1 行に簡素化(`messages.ts`。言語推定規則を削除し直接指定に) | なし |
| 1-2 | #1735 | Verify contract の簡素化(名残り・why 削除。83 → 約 30 行) | なし |
| 1-3 | #1736 | Execute contract の簡素化(名残り・反復削除。102 → 約 45 行) | なし |
| 1-4 | #1737 | Parent contract を reconcile 構成へ再編+圧縮(gap 表は保持。316 → 130〜150 行) | なし |
| 1-5 | #1738 | core `reconcile()` pure module + `lh workflow next`(advisory CLI・診断表示) | なし |
| 2-1 | #1739 | Parent contract を next 準拠へ(gap 表を削除し action 実行リストへ) | #1737, #1738 |
| 2-2 | #1740 | `lh workflow deliver`(pane 解決+activate+sanitize+注入の 1 コマンド化)+ contract 置換 | #1737 |
| 2-3 | #1741 | `lh workflow cost-hold`(await-human+Esc+通知+receipt の合成)+ contract 置換 | #1737 |
| 2-4 | #1742 | `lh workflow escalate-human`(Issue comment+Inbox+receipt の合成)+ contract 置換 | #1737 |
| 2-5 | #1743 | step status の observed-state 完全化(hold・rework count・未対応 out-of-band review・pending receipt) | #1738 |
| 3 | #1744 | `lh workflow next --watch`(event 受信・cursor 管理を内包)+ contract から watch/ack 削除 | #1739, #1743 |

## 推奨着手順

stage 1(#1734〜#1738、並行可)→ stage 2(#1739〜#1743、並行可)→ stage 3(#1744)。

## スコープ外(保留)

終盤形 = worker による決定的 parent 化 + one-shot LLM(無進捗診断・GitHub feedback 判断・
escalation 要約のみ LLM を都度呼ぶ)。next の運用経験を得てから設計・起票する。
