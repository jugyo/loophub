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

## 性能計測

計測対象は小・中・長文 fixture を Web SPA の rendered diff で Chrome に開き、render latency は `Rendered diff` click から `Head rendered diff` pane の DOM 出現まで、interaction latency は Base → Head の mode 切替 click から `aria-pressed="true"` への更新までとして測定した。long task は `PerformanceObserver({ type: "longtask" })`、memory は Chrome の `performance.memory.usedJSHeapSize` で取得した。同一ブラウザ session で各 fixture を 1 回ずつ測定したスナップショットであり、memory は JS heap のサンプル値である。

| fixture | render latency | interaction latency | main-thread long task | JS memory |
| --- | ---: | ---: | ---: | ---: |
| 小（3 blocks） | 33.6 ms | 25.6 ms | 0 件 | 16.5 MiB |
| 中（14 blocks） | 32.0 ms | 26.8 ms | 0 件 | 16.2 MiB |
| 長（32 blocks + table / image / Mermaid） | 43.9 ms | 26.2 ms | 0 件 | 16.6 MiB |

追加の折り畳みや自動 fallback は不要と判断した。長文でも long task は発生せず、interaction latency は 30 ms 未満、fixture 切替時の JS heap sample も 16.2–16.6 MiB の範囲だったため、現行の block 単位描画と pane 内スクロールを維持する。

補助的な実画面の browser vitals は TTFB 1.9 ms、FCP 96 ms、LCP 384 ms、CLS 0.08 だった。INP は操作イベントを含む集計ではないため、上表の mode 切替 latency を採用した。
