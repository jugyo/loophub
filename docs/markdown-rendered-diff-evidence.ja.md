# Markdown rendered diff 検証記録

## 要素 matrix

| Markdown 要素 | fixture の確認内容 | component test の確認 |
| --- | --- | --- |
| prose / heading / link / inline code | 見出し、段落、link、inline code | `pull-diff-dialog.test.tsx` の `renders GFM, tables, images, Mermaid, and long content in both panes` |
| nested list | list item 内の code block と sibling item | `pull-diff-dialog.test.tsx` の `renders GFM elements inside the diff preview typeset` |
| code block | fenced `ts` code block と fenced `mermaid` | 同上、および `pre code.language-mermaid` assertion |
| wide table | 列数の多い table と横スクロール領域 | `renders GFM, tables, images, Mermaid, and long content in both panes` |
| image | image block と added block marker | 同上、および `img` / `markdown-diff-block-added` assertion |
| Mermaid | Mermaid fenced block の code representation | 同上、および `pre code.language-mermaid` assertion |
| long prose | 120 paragraphs の長文 | 同上、および末尾 paragraph と `overflow-y-auto` assertion |

両 pane（Base / Head）を同じ fixture で描画し、Head 側では変更 block の `added` marker、Base 側では `removed` marker を確認した。prose、nested list、code block、wide table、image、Mermaid と両 marker が写る実画面は [markdown-rendered-diff-matrix.png](/attachments/2bc236311354eeab699ba6bfc19aa69957d7fc8f73cb157c7ca530a20ceb5f76) に保存した。

## 複数 hunk の表示順

2 つの離れた hunk で見出しと本文を変更する fixture を用意し、Unified では source diff の順に、1 つ目の削除 block、1 つ目の追加 block、周辺文脈、2 つ目の削除 block、2 つ目の追加 block と交互に並ぶことを確認した。light theme の実画面は [rendered-diff-multi-hunk-unified-light-rerun.png](/attachments/e393077358a3838ed6b887eb13bb0b13a4ad4eadf5a67057ebbe7184316b0494) に保存した。

同じ fixture の Split では Base と Head が独立した pane として全文を維持し、両側の変更 block が対応する位置に表示されることを dark theme で確認した。実画面は [rendered-diff-multi-hunk-split-dark-rerun.png](/attachments/4d739ce8865b8445a0ea134102e0400019b9f4614f0e54ada45bec5ac1b05a23) に保存した。

## 選択範囲の side

先頭への挿入により Head 3 行目の見出しと Base 3 行目の段落が異なる block になる fixture で、Head 3 行目から comment composer を開いた。Split では composer が `RIGHT 3` を維持し、Head の見出しだけに selected 表示が付き、同じ数値行を持つ Base の段落には付かないことを確認した。実画面は [rendered-diff-head-selection-side-split-rerun.png](/attachments/e4678f8efba942d356599a18c3be70b5f276edcd647ab64cde0c93b184a04eb4) に保存した。Unified へ切り替えた後も selected block は Head 側の 1 件だけだった。

## Mermaid comment action

Mermaid block の内容を Base / Head 間で置換する fixture を Unified で描画し、removed / added diagram が source diff 順に並ぶことを確認した。両側の comment button は対応する diagram と同じ ordered block 内にあり、diagram と同じ上端位置に表示された。実画面は [rendered-diff-mermaid-actions-unified-rerun.png](/attachments/07753103e5493d0a0110d8b50489807202399db8adc35f2a978d9c4f234e678f) に保存した。

## Container block threads

単一項目 list の 1 行目と table delimiter の 4 行目に inline thread を作成し、各 thread が対応する container の直後に表示されることを確認した。Unified では list thread が `UL` の直後かつ `order: 5`、table thread が `TABLE` の直後かつ `order: 15` にあり、どちらも Previous diff へ移動しなかった。Split でも同じ container 直後に両 thread が表示された。実画面は [rendered-diff-container-threads-unified-rerun.png](/attachments/eb80f1f661b7849f83a6c322ddd2ed2901d66702e4bc2304aea8941472d6da14) と [rendered-diff-container-threads-split-rerun.png](/attachments/4e2f2f8559dd8bf5b538340e7753e12380d92e0f7b519d4380dad5b109dd1718) に保存した。

## Unified reading track

複数 hunk fixture の top-level block と inline thread group を 46rem の共通 reading track に揃え、diff block 間を 0.75rem に統一した。1600 × 1000 の実画面では、visible block 11 件がすべて左端 602px、幅 736px、上 margin 12px となり、removed / added pair と context が同じ軸で並ぶことを確認した。light theme は [rendered-diff-unified-reading-track-light-rerun.png](/attachments/e393077358a3838ed6b887eb13bb0b13a4ad4eadf5a67057ebbe7184316b0494)、dark theme は [rendered-diff-unified-reading-track-dark-rerun.png](/attachments/d5225e7e347c83a1f3d69e3ed5e99576ba2b7f3feca3ec7ec72c5e443a002efb) に保存した。

## Split reading track

Split の各 pane でも top-level block と inline thread group に共通の 46rem 上限を適用し、table や image の intrinsic width による縮みを抑えた。1600 × 1000 の実画面では、Base の direct block がすべて左端 369px・幅 589px、Head がすべて左端 983px・幅 588px となり、各 pane 内で同じ左端と幅に揃うことを確認した。light theme は [rendered-diff-split-reading-track-light-rerun.png](/attachments/1a56a9efe268feff7d0eaa64b2b1b66e0b27e3c59df4801cd404160743809450)、dark theme は [rendered-diff-split-reading-track-dark-rerun.png](/attachments/4d739ce8865b8445a0ea134102e0400019b9f4614f0e54ada45bec5ac1b05a23) に保存した。

## 性能計測

計測対象は小・中・長文 fixture を Web SPA の rendered diff で Chrome に開き、render latency は `Rendered diff` click から `Head rendered diff` pane の DOM 出現まで、interaction latency は Base → Head の mode 切替 click から `aria-pressed="true"` への更新までとして測定した。long task は `PerformanceObserver({ type: "longtask" })`、memory は Chrome の `performance.memory.usedJSHeapSize` で取得した。同一ブラウザ session で各 fixture を 1 回ずつ測定したスナップショットであり、memory は JS heap のサンプル値である。

| fixture | render latency | interaction latency | main-thread long task | JS memory |
| --- | ---: | ---: | ---: | ---: |
| 小（3 blocks） | 33.6 ms | 25.6 ms | 0 件 | 16.5 MiB |
| 中（14 blocks） | 32.0 ms | 26.8 ms | 0 件 | 16.2 MiB |
| 長（32 blocks + table / image / Mermaid） | 43.9 ms | 26.2 ms | 0 件 | 16.6 MiB |

追加の折り畳みや自動 fallback は不要と判断した。長文でも long task は発生せず、interaction latency は 30 ms 未満、fixture 切替時の JS heap sample も 16.2–16.6 MiB の範囲だったため、現行の block 単位描画と pane 内スクロールを維持する。

補助的な実画面の browser vitals は TTFB 1.9 ms、FCP 96 ms、LCP 384 ms、CLS 0.08 だった。INP は操作イベントを含む集計ではないため、上表の mode 切替 latency を採用した。
