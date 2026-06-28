# 内蔵ターミナルの PTY 管理 — tmux backend 設計

> Status: Design · Issue: #303(設計)/ #309(実装) · 関連: #253 / #254 / #255(描画・IME・UX)
> 対象は **設計のみ**。実装(tmux 連携・backend 切替のコード/テスト)は #309 に切り出す。
> 既存コード: `web/server/terminal.ts`(WS↔PTY ブリッジ)/ `core/pty.ts`(PTY ドメイン)。

---

## 1. 背景と現状アーキテクチャ

内蔵ターミナルは、lh-web の `node:http` サーバに WebSocket を相乗りさせ(第二ポート不要)、
1 本の WebSocket を 1 本の PTY に橋渡しする。

- **1 WebSocket == 1 PTY**: `handleConnection`(`web/server/terminal.ts:97-154`)が `/terminal`
  upgrade ごとに `createPtySession` を呼び、`session.onData → ws.send` / `ws.message →
  write|resize` / `session.onExit → ws.close` を結線する。
- **PTY は lh-web の子プロセス**: `createPtySession`(`core/pty.ts:121`)が
  `node-pty.spawn(shell)` を lh-web プロセスの子として起動する。共通 interface は
  `PtySession = { pid, onData, onExit, write, resize, kill }`(`core/pty.ts:51-58`)。
- **ライフサイクルが socket に束縛**: `ws.on("close" | "error") → session.kill()`
  (`web/server/terminal.ts:151-153`)。リロード・タブクローズ・ビュー unmount で socket が
  切れると PTY が即 kill される。これはプロセスを leak させない現行設計の意図。

### 1.1 「lh-web 終了で全 PTY 消失」の因果

PTY は lh-web の子プロセスなので、lh-web が落ちると PTY master の fd が閉じられ、子プロセスへ
SIGHUP が届いて終了する(unclean exit では子は一旦 init/launchd に再ペアレントされたのち、
master-close 由来の SIGHUP で落ちる)。加えて clean shutdown 時は、
`attachTerminalServer` の stop 関数が全 client socket を close し各 `session.kill()` を呼ぶ
(`web/server/terminal.ts:89-94`)。再起動後の新しい lh-web は旧 PTY への参照を一切持たない。
クライアント側(`web/src/components/terminal-view.tsx`)も session 識別子を保持せず、
再 mount = 新規 WS = 新規 PTY であり、**resume の概念がそもそも存在しない**。

本設計はこの束縛を解き、PTY を lh-web のライフサイクルから切り離して再起動後も生存・再接続
できるようにする。tmux が使えない環境では現行の自前 PTY 管理へフォールバックする。

---

## 2. tmux 方式の機能対応付け

lh-web は PTY を子として抱えず「`tmux` を叩く orchestrator」になる。現行各機能の対応:

| 機能 | 現状 | tmux backend |
|------|------|--------------|
| セッション命名 | 無名 PTY | `loophub-<owner>-<repo>-<slug>` のような決定的名。repo/用途から導出し再接続キーにする |
| 作成 | `node-pty.spawn(shell)` | `tmux new-session -d -s <name> -c <cwd> -x <cols> -y <rows> [shell]`(`-d` detached) |
| 出力ストリーム | `onData` cb | `tmux attach -t <name>` を node-pty で包んだ**薄い PTY** を 1 本張り、その出力を WS へ流す |
| 入力書き込み | `proc.write` | attach PTY へ write(raw バイトを扱いにくい `send-keys` より attach 方式を推奨) |
| resize | `proc.resize` | attach PTY を resize → tmux client size 変更。共有 attach 時の方針は §6 |
| 初期コマンド注入 | first-data 時に `${cmd}\r` を write | **新規作成時のみ** `send-keys -t <name> <cmd> Enter`。再接続時は注入しない(二重実行防止)。`initialCommandInput` のロジックは再利用 |
| cwd 解決 | `resolveTerminalCwd(repo)` | 変更なし。`new-session -c <cwd>` に渡す |

**推奨形(ハイブリッド)**: 制御は `tmux` サブコマンド、入出力は「`tmux attach` を node-pty で
包んだ薄い PTY」。これで既存の WS↔PTY データ経路(`web/server/terminal.ts`)をほぼそのまま
流用でき、差分は「子 PTY が shell ではなく `tmux attach`」になる点に閉じる。

---

## 3. backend 差し替え抽象

現行 `PtySession` を流用しつつ backend を抽象化する:

```ts
interface TerminalSession {
  readonly id: string;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;        // 明示終了
  detach?(): void;     // tmux のみ: socket 切断時に kill ではなく detach
}

interface TerminalBackend {
  readonly name: "tmux" | "pty";
  isAvailable(): boolean;
  open(opts: {
    cwd: string;
    cols?: number;
    rows?: number;
    command?: string;
    sessionKey?: string;
  }): TerminalSession;
}
```

- 現行 `createPtySession` を `PtyBackend.open` へ移植、`TmuxBackend.open` を新設。
- 起動時の選択は純関数 `selectBackend(env)`(`core/terminal-backend.ts` 等)に置き、
  env opt-in + `isAvailable()` で 1 つに確定する。`web/server/terminal.ts` は backend を
  意識せず `backend.open(...)` を呼ぶだけにする。

---

## 4. tmux 可否検出とフォールバック判定

- **検出**: `tmux -V` 成功 + 最低 version。採用方式は `tmux attach` を node-pty で包むため
  `pipe-pane` / control mode(`-CC`)は使わない。floor は実際に使う機能で決める — `new-session
  -x/-y` と複数 attach 時の `window-size`(2.9 で追加)を基準に、例 ≥ 3.0(広く流通する安定版)
  程度で十分。結果は起動時 1 回キャッシュ。
- **opt-in env**: `LOOPHUB_TERMINAL_BACKEND=tmux|pty|auto`。当面の既定は `pty`(現行挙動維持)、
  `auto` は検出成功で tmux・失敗で pty。
- **フォールバック基準**:
  - tmux 未インストール / version 不足 → pty
  - `tmux new-session` 失敗(server 起動不可、socket dir 不可)→ pty
  - Windows(`platform === "win32"`)→ pty 固定(tmux 非対応)
- 方針は「起動時に backend を 1 つ確定」を基本とし、ランタイム個別 degrade は将来拡張。

---

## 5. セッションライフサイクル

- **生成**: WS 接続時に sessionKey で `tmux has-session` を確認。無ければ `new-session -d`、
  有れば attach のみ(初期コマンドは新規時だけ)。
- **再接続(lh-web 再起動後 resume)**: tmux server は lh-web と独立プロセスなので生存。
  再起動後、クライアントが同 sessionKey で WS を張れば `has-session` ヒット → attach で復帰。
  初期描画は `capture-pane` / history-limit の backlog から。**クライアント側に sessionKey の
  永続化(URL / localStorage)を追加する必要がある**(#309 で実装)。
- **破棄**: socket 切断では **kill せず detach のみ** — これが tmux 方式の肝で、現行
  「socket 切断で即 kill」からの最大の挙動変更。明示終了(タブの「終了」操作 or shell exit)
  時のみ `tmux kill-session`。
- **孤児回収**: detach 放置 session を、(a) アイドル TTL で `kill-session`、(b) lh-web 起動時に
  `loophub-*` prefix を列挙し repo 消滅/古いものを掃除、(c) 上限数で LRU kill。最小は (b) + TTL。

---

## 6. セキュリティ / 制約への影響

- **loopback 限定**: 不変。WS の Origin チェック(`isAllowedOrigin`)と bind は据え置き。
  tmux server は Unix domain socket(`$TMUX_TMPDIR`)でネット露出しない。新たな考慮は
  「同一ユーザの別ローカルプロセスが `tmux attach` で入れる」点 — 脅威モデル内だが
  socket 権限 0700 を確認する。
- **session 名/ターゲットのサニタイズ(client 由来入力)**: session 名
  `loophub-<owner>-<repo>-<slug>` は client 提供の `repo`(`web/server/terminal.ts:79`)由来で、
  `has-session` / `attach` / `send-keys` / `kill-session` の `-t <name>` ターゲットに使われる。
  tmux の target-spec は `:` `.` `@` `$` `%` を window/pane/session セレクタとして解釈するため、
  これらを含む名がそのまま渡ると別 `loophub-*` セッションへ誤解決し、attach/kill が他 repo の
  ターミナルに当たる(confused-deputy = 出力漏洩 + 別 shell の操作)。#309 では (a) session 名を
  allowlist 変換(hash か `[A-Za-z0-9_-]` のみの slug)で生成し raw バイトを渡さない、(b) tmux は
  argv 起動(`execFile` / `spawn`、shell 文字列は禁止)、(c) sessionKey は URL/localStorage を
  信頼せず**解決済み repo レコードからサーバ側で正規化**する、を必須とする。
- **cwd のセッション内固定**: tmux でも `new-session -c` で固定。ただし session が永続するため
  repo の local_path が後で変わると古い cwd の session が残る → §5 の回収方針でカバー。
- **複数クライアント attach(共有表示)**: tmux は複数 attach 可。同一 sessionKey に複数 WS が
  attach すると **画面共有(同一入出力)** になり、現行(1WS1PTY・共有不可)からの挙動変更。
  既定は共有許可、resize は `window-size smallest` か最後の resize 優先かを実装時に決める。
  分離したい用途は sessionKey にクライアント固有要素を混ぜる。
- **`~/.tmux.conf` の影響**: ユーザ設定で status line / key bindings が予測不能になる。
  LoopHub 用途では `-f /dev/null` か専用 config で遮断するのが安全。

---

## 7. 結論

- **採用方針**: `TerminalBackend` 抽象を導入し、`tmux attach` を node-pty で包んだ薄い PTY を
  データ経路に据えた **tmux backend** を追加。自前 PTY backend はフォールバックとして維持。
  backend は起動時 env(`LOOPHUB_TERMINAL_BACKEND`)+ 検出で 1 つ確定。
  **socket 切断は detach、明示終了で kill-session**。
- 実装は **#309** で行う(`TerminalBackend` 抽象 → `PtyBackend` 移植 → `TmuxBackend` 追加 →
  session 名サニタイズ + tmux の argv 起動(§6)→ クライアント sessionKey 永続化 → 孤児回収・TTL
  → 純関数の単体テスト)。
