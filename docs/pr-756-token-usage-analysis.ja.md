# PR #756 トークン消費調査 (gpt-5.5 / 96.6M tokens / $90.01)

2026-07-05 に `lh dev --codex 749` で開発した PR #756（常駐バックグラウンドループを
lh-web から lh-worker へ移す）が、1 PR で 96,592,371 トークン（gpt-5.5, $90.01）を
消費した原因の調査記録。

## 結論

- 総トークンの **約 88%（85.9M）は lh-pr-review のレビューアサブエージェント**が消費した。
  実装を行った main セッション自体は 11.3M（約 $9）。
- 総トークンの **93.4% は cache read**（gpt-5.5 で $0.5/M）。キャッシュヒット率としては
  良好だが、cache read だけでコストの半分（$44.9）を占めた。
- 構造要因は3つの掛け算:
  1. **レビューアが main 会話のフォークとして起動され、全履歴を prefix に継承した**
  2. **low 指摘1件の修正ごとに 3 ロールのフル再レビューを、より長い履歴の上で再実行した**（計4 round）
  3. **レビューア1体あたり 62〜108 API コール**（毎ターン全コンテキスト再送）

## データソース

- LoopHub DB: `session_usage`（session_id `39342ca6-bdcb-40c1-875d-3023702a4e66`）
  - input 6,320,358 / cache_read 89,822,080 / output 449,933 / cost_usd 90.01
- Codex rollout 直読み: `~/.codex/sessions/2026/07/05/rollout-*019f32*.jsonl` の
  `token_count` イベント（`last_token_usage`）をファイル別に集計
  - 合計: input 96.7M（うち cached 90.3M）/ output 0.46M — LoopHub の記録とほぼ一致

## 実態: 1 セッションではなく 15 会話

`/lh-dev 749` は 1 つの LoopHub セッションとして記録されているが、rollout ファイルは
15 個あった。main 1 つ + フォーク 14 個。全フォークが main の会話履歴
（issue 読解〜実装〜テストの全過程）を prefix として共有し、その末尾にロールプロンプト
（Quality / Security / Acceptance reviewer）が注入されている。

| フェーズ | 会話数 | ターン数 | トークン (in+out) |
|---|---|---|---|
| main セッション（実装、23:17–23:45 JST の28分） | 1 | 108 | 11.3M |
| レビュー round 1（23:27, 3 ロール並列） | 3 | 62–64 | 12.6M |
| レビュー round 2（23:31） | 3 | 76–85 | 18.6M |
| レビュー round 3（23:36） | 3 | 93–95 | 23.9M |
| レビュー round 4（23:41） | 3 | 104–108 | 30.2M |
| skeptic 等の小フォーク | 2 | 8–12 | 0.6M |
| **合計** | **15** | **~1,150** | **97.2M** |

round が進むほど main の履歴（prefix）が伸びるため、レビューア1体あたりのコストが
4.2M（round 1）→ 10.1M（round 4）へ単調増加している。round 2〜4 の合計 72.7M は
「low 3 件の修正確認」のために使われた。

## コスト内訳（$90.01）

| 項目 | トークン | 単価 | コスト |
|---|---|---|---|
| cache read | 89.8M | $0.5/M | $44.9 |
| 非キャッシュ入力 | 6.3M | $5/M | $31.6 |
| 出力 | 0.45M | $30/M | $13.5 |

キャッシュは 93.4% ヒットしており、無ければ同じ挙動で $480 前後になっていた。
問題はキャッシュの効きではなく、「伸び続ける履歴 × 全ロール再実行 × フォーク継承」
という構造の方。1 ターンあたり平均 ~84k トークンの履歴を約 1,150 回再送している。

## 改善提案（効果の大きい順）

1. **レビューアをフォークではなく新規セッションで起動する**（最大のレバー）。
   ロールプロンプトは repo パス・diff 範囲・AC を含む自己完結型で、main 履歴の継承は
   純粋な無駄。`codex exec` の新規非対話セッションにロールプロンプト + `lh pr diff` を
   渡せば 1 体 0.3〜0.5M 程度で済み、85.9M → 5M 前後まで落ちる計算。
   lh-pr-review SKILL.md の「Reviewer roles & host mapping」に
   「履歴を継承しない機構を優先する」規定を足すのが本丸。
2. **再レビューの縮退。** 前 round の指摘が low のみなら、次 round は 3 ロールの
   フル再実行ではなく「修正コミットの diff だけを 1 レビューアで確認」に落とす。
   今回なら round 2〜4 の 72.7M がほぼ消える。low を non-blocking 扱いにして
   round 1 で pass にする運用ならさらに減る。
3. **レビューアに diff を最初から同梱する。** 1 体 100 ターン近い repo 再探索が
   積み上がっている。プロンプトに diff 全文を入れればターン数が数分の一になる。
4. **main 側のテスト実行の重複を減らす。** focused テストの組み合わせ違い 3 回 +
   full `npm test`（61 ファイル）複数回が記録されている。反復中は focused のみ、
   full は最後に 1 回で十分。
5. **確認系 round のモデルを落とす。** 修正確認のような機械的 round は
   gpt-5.4（$2.5 / $0.25 per M、gpt-5.5 の半額）で足りる。

## 再現用クエリ

```sh
# PR に紐づくセッションと使用量
sqlite3 -header ~/.loophub/loophub.db "
SELECT s.id, s.agent, u.model, u.input_tokens, u.cache_read_input_tokens,
       u.output_tokens, u.cost_usd
FROM session_links l
JOIN issues i ON i.id = l.issue_id
JOIN agent_sessions s ON s.id = l.session_id
LEFT JOIN session_usage u ON u.session_id = s.id
WHERE i.number = 756;"

# rollout ファイル別のトークン集計（token_count イベントの last_token_usage を合算）
ls ~/.codex/sessions/2026/07/05/rollout-*019f32*.jsonl
```

価格テーブルは `core/session-usage.ts` の `GPT_55_PRICE` を参照。
