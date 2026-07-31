# Herdr prompt が pane に残り未送信で止まる根本原因

## 結論

`herdr pane send-text` は本文を pane の PTY へ **plain な bytes** として書き込む。bracketed paste
marker が無いため、coding agent の TUI は「paste か typing か」を到着タイミングだけで判定し、
本文の burst を paste と分類したうえで、直後に届く `Enter`(`\r`) を paste の中身として飲み込む。
その結果、本文は入力欄に残り未送信になる。

`send-text` と `send-keys Enter` を別の Herdr request に分けても解決しない。2 つの request は
別 process だが、PTY 上では **約 7ms 差**で連続して届き、TUI の paste 判定窓の内側に収まるためである。
これが #2114 / #2122 / #2134 の修正後も再発した理由。

修正は、本文を bracketed paste (DEC 2004) で囲むこと
(`core/service/herdr-prompt.ts:61-69`)。閉じ marker `ESC[201~` が terminal 自身の parser で
paste 区間を終わらせるので、その後の `\r` は bytes のまとまり方に関係なく key press として解釈される。
タイミングに依存しない保証になる。

## 事実(実機 pane での観測)

観測はすべて herdr 0.7.1、session `jugyo-loophub-3384ded7` の実 pane で行った。

1. **`send-text` は raw bytes を書き、`send-keys Enter` は `\r` 1 byte を書く。**
   PTY を raw mode で読む probe を pane で走らせ、`pane send-text w00:p1 'HELLO-SHORT'` →
   `pane send-keys w00:p1 Enter` を実行した結果:

   ```
   [1785453207.413904 len=11] b'HELLO-SHORT'
   [1785453207.926889 len=1]  b'\r'
   ```

   bracketed paste marker は付かない。長い本文は 1022 bytes ごとに分割され、chunk 間の遅延は無い
   (同一 µs のタイムスタンプで連続)。

2. **修正前の `sendHerdrPrompt` では `\r` が本文の 7ms 後に届く。**
   worktree の `sendHerdrPrompt` をそのまま呼び、2522 bytes の本文を配送した際の PTY 観測:

   ```
   t+0.000 len=1022 b'workflow instruction: XXXX...'
   t+0.000 len=1022 b'XXXX...'
   t+0.000 len=478  b'XXXX...'
   t+0.007 len=1    b'\r'
   ```

   `runHerdr` は subprocess の `close` で resolve する
   (`core/service/herdr-runner.ts:100-118`) が、それは pane 側の処理完了を意味しない。

3. **Claude Code 2.1.220 で未送信を再現。** 2426 bytes の本文を修正前の手順で配送すると、入力欄に
   本文が残った。paste と判定された証拠として placeholder が出ている:

   ```
   ❯ [Pasted text #1][Pasted text #2]xxxxxxxx... probe-end
     paste again to expand
   ```

   同じ手順を繰り返すと送信される回でもあり、**間欠的**である(TUI 側の read 境界に依存するため)。

4. **Codex 0.145.0 では `Enter` が paste に取り込まれたことが byte 数で確認できる。**
   2426 bytes の本文と `\r` を 1 回の `send-text` で送ると、入力欄の表示は:

   ```
   › [Pasted Content 2427 chars]
   ```

   2426 + 1 = 2427。`\r` が submit key ではなく paste の 1 文字として数えられている。

5. **bracketed paste で囲むと、最悪条件でも送信される。** 本文を `ESC[200~` … `ESC[201~` で囲み、
   `\r` を**同一の `send-text` request**に含めた場合(タイミング差 0)、Claude Code / Codex とも送信された
   (Codex は `Working (2s...)` に遷移し入力欄は placeholder に戻った)。

6. **修正後の実機確認。** 修正済みの `sendHerdrPrompt` を 2426 bytes の本文で
   Claude Code pane に 3 回、Codex pane に 3 回配送し、いずれも入力欄に本文が残らず送信された
   (Codex 側 transcript に `› probe-marker-A1` が残る)。

## 配送側の成功報告と実際の送信

修正前は、`send-keys Enter` の exit 0 は「pane に `\r` が書かれた」ことしか保証せず、submit されたか
どうかは TUI の paste 判定次第だった。bracketed paste 導入後は、`\r` が paste 区間外であることが
byte 列として確定するため、両 request が成功すれば submit が成立する。どちらかの request が失敗した
場合は従来どおり phase 付きの `HerdrPromptError` として可視化される
(`core/service/herdr-prompt.ts:9-24`、利用側は `core/service/terminal.ts:1088-1095`)。

## 回帰テスト

`core/service/herdr-prompt.test.ts` の fake herdr は command log ではなく **pane の PTY が受け取る
byte 列**を記録し、`pane()` がその byte 列を TUI の入力処理モデル(paste 区間内の `\r` は改行、
plain な burst に続く `\r` も paste として飲まれる)で解釈する
(`core/service/herdr-prompt.test.ts:61-93`)。したがってコマンド列の一致ではなく、
「submit key が終端済み paste の外に置かれているか」という根本原因の不変条件を検査する。

`pasted()` を恒等関数に戻すと 3 件の test が失敗することを確認済み。

## 本文中の ESC の扱い

paste 区間を delimiter で表現する以上、本文が `ESC[201~` を含むと paste を途中で終わらせ、残りが
key press として解釈されうる。そのため本文からは ESC (0x1b) を除去する
(`core/service/herdr-prompt.ts:64-69`)。prompt 本文に raw ESC の正当な用途は無い。

## 未解明の隣接症状(この修正の対象外)

pane `w0M:p2` (Codex, run 484) には、workflow instruction が JSON の途中
(`,"rework_limit":8,...`) から始まる**断片**として届き、Codex が「完全な instruction を再送してほしい」と
応答した記録が残っている。これは「未送信」ではなく先頭部分の欠落であり、本修正では説明できない。
別 issue として切り出すのが妥当。

## 証跡(引用の存在確認)

```sh
rg -n 'PASTE_START|PASTE_END|function pasted' core/service/herdr-prompt.ts
rg -n 'send-text|send-keys' core/service/herdr-prompt.ts
rg -n 'function pane\(|inPaste|typed' core/service/herdr-prompt.test.ts
rg -n 'sendHerdrPrompt' core/service/herdr-agent-control.ts core/service/workflow-instructions.ts core/service/terminal.ts
rg -n 'u001b\[200~' cli core web
```
