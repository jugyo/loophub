# Coding agent 設定 UI の仕様（案 B のテーブル + 案 D のドロップダウン方式）

本ドキュメントは、Application Settings の **Coding agent** 設定ブロックの実装仕様です。UI プロトタイプ
比較（issue #41、PR #42）のレビューで人間が選定した方針を書き起こしたもので、プロトタイプの実装その
ものではありません。選定の根拠は PR コメント #92（「B をベースに、ドロップダウンは D の方式で」）。

## 選定された方向

- **レイアウトのベースは案 B**: 横 1 行 = 1 agent、列 = Agent / Model / Effort のテーブル。
  全 agent の設定を一度に比較でき、ネストによる折り返しがない。
- **ドロップダウンは案 D の方式**: Model / Effort を**別々の単一セレクタ（single-field dropdown）**で
  選ぶ。model×effort の組み合わせを flat に列挙するリストや、二段階の model → effort submenu（案 E）は
  採用しない。表のセルにそのまま入る幅の、1 列 = 1 設定のドロップダウンを各列に置く。

## 構成

### アプリ側（Application Settings）

- 見出し: **Coding agent**
- 説明文: デフォルトはコードを運転する agent の設定である旨
- テーブル:
  - 行ヘッダ列: default 判定のマーカー（ラジオ相当）。「Default」という語は置かず、マーカーそのもので
    default agent を表す（人間フィードバック #40）。
  - 列: **Agent** / **Model** / **Effort**
  - 1 行 = 1 agent。マーカーで default agent を選択できる。
  - **Model** 列: その agent の model 候補から選ぶ single-field ドロップダウン。
  - **Effort** 列: その agent の effort 候補から選ぶ single-field ドロップダウン。effort 未対応の
    agent（cursor / opencode など候補が空）はセルを「—」で表示。
  - 各セルの初期値は runtime registry（`core/runtimes.ts`）の default model / default effort。
- ドロップダウンの表示ラベル: model 名・effort は表示用ラベルで表示する（人間フィードバック #84）。
  例: `claude-opus-5` → 「Claude Opus 5」、`xhigh` → 「Extra high」。
- ドロップダウンの横幅: セルに収まる自然な幅（トリガー幅へ引き延ばさない）（人間フィードバック #83）。

### データ元

- agent・model・effort の候補と default は、既存の runtime registry（`core/runtimes.ts`）を単一の
  真実源として参照する（`web/src/lib/agent-models.ts` が導出して供給）。

## 実装にあたっての注意

- 本仕様はプロトタイプ（案 B / 案 D）から確定方向を書き起こしたものであり、実装時は設定の永続化・
  RPC 契約を改めて決める（プロトタイプはローカル state のみ）。
- repo override（案 D が試した per-repo 上書き）は、本仕様の範囲を超えるため扱わない。
