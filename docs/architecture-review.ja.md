# LoopHub アーキテクチャレビュー

> **種別**: 俯瞰レビュー(スナップショット)。2026-07-04 時点、main = `9cfb28c` に対する調査。
> **スコープ**: core / cli / web(server + SPA) / worker の設計・実装・テスト体制・セキュリティを横断。
> ここでの指摘は設計の弱点と改善案の記録であり、個別の修正は別 issue で行う。
> 行番号はレビュー時点のもので、コードの変更により古くなり得る。

---

## 全体像と、まず良い点

コードベースは docs の設計(worktree 設計、cc-session-state-push、canon)と実装がよく一致しており、ドキュメントが「書いただけ」になっていない。特に以下は水準が高い:

- **純粋ロジックの切り出し**(`core/mergeable.ts` / `core/merge-mode.ts` / `core/worktree-prune.ts` / `core/worker-cursor.ts` / `cli/dev.ts` の argv 構築)。副作用なし・DI 済み・単体テスト済みで、AGENTS.md の規約が実際に機能している。
- **敵対的入力への一貫した防御**。GitHub 由来タイトルの ANSI/bidi 除去、herdr stdout の ID 正規表現検証、`gh` への `--` ガード、attachment の sha256 検証、DNS rebinding 対策の Origin チェック(`web/server/http.ts:307-338`)は、ローカルツールとしては異例に丁寧。
- **atomic write パターン**(temp+rename)が cursor / config / dev-lock で一貫。
- **core→web の一方向レイヤリング**が守られている(`core/events-follow.ts` がわざわざ wire frame を再定義してまで維持)。

以下、弱点を深刻度順に挙げる。各項目に事実(コードで確認済み)/仮説(推論)のラベルを付す。

---

## クリティカル(設計・実装の弱点)

### C1. 複数行ミューテーションにトランザクションがほぼ無い【事実】

リポジトリ全体で明示トランザクションは 2 箇所のみ(`core/store.ts:182` の repo rename と `core/db.ts:609` の一回きりの table rebuild)。一方で不変条件を跨ぐ書き込みが素の auto-commit で並んでいる:

- **`setMerged`**(`core/store.ts:647-677`) — PR を merged にする / PR issue を close / linked issue を close が **3 つの独立した `db.run`**。途中クラッシュや `SQLITE_BUSY` 枯渇で「merged=1 なのに issue が open」等の不整合が残る。
- **`deleteRepo`**(`core/store.ts:197-239`) — 11 テーブルへの ~15 連続 DELETE が非アトミック。FK 順序はコメントで手動管理されており、まさにトランザクションが守るべきケース。
- **`pulls.merge`**(`core/service.ts:2735-2760`) — git の ref 前進と DB の `setMerged` が別ステップ。git 成功後に死ぬと「git 上は merge 済み、LoopHub 上は open で再 merge 可能」になり、補償処理も無い。

**改善案**: `core/db.ts` に `transaction(fn)` ヘルパー(`BEGIN IMMEDIATE` … `COMMIT`/`ROLLBACK`)を 1 つ足し、`setMerged` / `deleteRepo` / `createPull` を包む。git+DB を跨ぐ `pulls.merge` は DB トランザクションでは守れないので、「merge_commit_sha を先に DB へ pending 記録 → git → confirm」の 2 相にするか、少なくとも起動時/sync 時に「base に merge 済みなのに open な PR」を検出して self-heal する reconcile を入れる(worktree 台帳で採った「ディスクが真実 + self-heal」と同じ思想で解ける)。

### C2. RPC 契約の 3 層ドリフトを守るものが何も無い + CI 不在【事実】

契約は `web/server/contract.ts`(ajv スキーマ) → `docs/rpc-contract.json`(生成物・git 管理) → `web/src/api/types.ts`(**手書き**、475 行、「keep these in sync manually」と自己申告)の 3 層だが:

- `.github/workflows` が**存在しない**。lint / typecheck / 2 つのテストスイート / `npm run contract` すべて手動任せ。
- `npm test` はルートの vitest しか走らせず、**web のコンポーネントテスト(~45 ファイル)は `npm --prefix web test` を別途叩かないと走らない**。
- result スキーマは `anyObject` の documentation-only(`web/server/contract.ts:34-36`)なので、レスポンス形状のドリフトはサーバ側でも捕まらない。

churn 分析(直近 3 ヶ月・321 commits)で `api/types.ts` は 50 回、`contract.ts` は 40 回変更されており、ドリフト機会は毎週発生している。AI エージェントが AFK で回す前提のリポジトリで、マージ前の機械的ゲートが無いのは思想と実態の最大のギャップ。

**改善案**: (1) CI を追加 — `biome check` + `tsc` + 両テストスイート + `npm run contract && git diff --exit-code docs/`。(2) `types.ts` を契約から生成するか、最低限「contract の全 method が client/types に存在する」ことを assert する適合テストを 1 本書く。費用対効果は本レビューの指摘の中で最大。

### C3. `core/service.ts`(3,714 行)と `core/store.ts`(1,594 行)の god module 化【事実】

`service.ts` は 21 の namespace facade を 1 ファイルに持ち、直近 3 ヶ月で **79 回変更**(全ファイル中 1 位)。「thin CLI」の規律が複雑さをこの 2 ファイルへ押し込んだ形。さらに store の戻り値はほぼ全部 `any`(`getIssue`/`getPull`/`listIssues` すべて)で、issue/pull ドメイン全体が型なしで service → serialize → 契約層を流れており、**DB 行の形が事実上の契約なのにコンパイラが何も守っていない**。

**改善案**: 呼び出し側は既に `service.pulls.*` 形式なので、`core/service/pulls.ts`, `core/service/herdr.ts`, … へ機械的に分割でき、コールサイト変更ゼロ。store も同様に分割可能。`any` は一気に直さず「新規・変更した関数から Row 型を付ける」方針で漸進すればよい。エージェント並行開発でのコンフリクト削減効果が大きい。

### C4. 「SQLite テーブル = メッセージバス」のイベント伝搬に取りこぼしの構造リスク

**事実**: クロスプロセス伝搬はすべて autoincrement id カーソルのポーリング(`web/server/events.ts:99-120`、`worker/runner.ts`、~1s 間隔)。また `emitEvent` は先行するドメイン変更と**別コミット**なので、変更とイベントの間でクラッシュすると「状態は変わったがイベントが無い」が起きる(`core/store.ts:1494` / `core/service.ts:2750` 付近)。

**仮説**(SQLite の既知挙動に基づく・この repo では未実証): WAL 下では id の割当順とコミット可視化順が一致しないため、並行書き込み時に「低い id が、reader のカーソルが高い id を通過した後に可視化」され、`id > cursor` の tail が**恒久的にイベントを飛ばす**古典的レースがあり得る。worker は cursor を dispatch 後に永続化するので at-least-once でもない。

**改善案**: 現実的な順で (1) 変更+`emitEvent` を C1 のトランザクションで同一コミットにする(これで「イベント無き変更」は消える)、(2) tail 側は「カーソル付近を数秒ぶんオーバーラップして再読 + 購読側 dedup(既にある)」で可視化レースを吸収、(3) worker はイベント id ごとの処理済み記録を持つ。フルのメッセージバス導入は不要で、この 3 点で足りる。

### C5. セキュリティ: 非 loopback バインド時に実質無防備【事実】

認証は一切なく、`LOOPHUB_HOST=0.0.0.0` にすると Origin 許可リストが**丸ごとスキップ**され(`web/server/http.ts:320` のゲートが loopback バインド時のみ)、残るのは `Sec-Fetch-Site` のみ — curl 等の非ブラウザクライアントには効かない。その先には `terminal/launch`(プロセス起動)、`pulls/merge`、`pulls/createGithubPull`(GitHub へ push)というローカル操作の全権 RPC が確認なしで並ぶ。加えて `/rpc` のボディは**サイズ無制限**で全量メモリ連結(`web/server/http.ts:57-64`、attachment 側の 10MB 制限と対照的)。

**改善案**: (1) 非 loopback バインド時はトークン必須にする(起動時に生成して URL に埋める、いわゆる Jupyter 方式)か、そもそも `0.0.0.0` を拒否してリバースプロキシに委ねる。(2) `readBody` に 1〜4MB 程度の上限(attachment 用の bounded reader が既にあるので流用)。ローカル単独利用なら現状でも成立するが、「LAN の別マシンから見る」を一度でもやると崩れる崖なので、崖の存在をコードで塞ぐべき。

---

## 中程度(全体設計に効く改善)

- **`lh dev` の CLI ブランチが規約違反の最大例**(`cli/index.ts:343-853`、~510 行)。dev-lock 取得、worktree 準備、herdr ワークスペース編成 ~130 行までが CLI 内にあり、しかも web 側の `launchIssueDevHerdr` と実質重複。`worktrees.plan/remove` で自ら示した手本どおり `service.dev.launch()` へ移すのが筋。spawn+エラー処理の同型ブロックも 4 箇所コピペされている(`cli/index.ts:843`, `:1145` ほか)。
- **git サブプロセスのファンアウト**。PR 1 件のステータス表示に ~6 プロセス(`core/serialize.ts:313-391`)、`diffFiles` はファイルごとに `git diff` 1 回(`core/git.ts:159`)。PR 30 件のリストページで ~180 プロセス。1 リクエスト内での `revParse`/`remoteUrl` のメモ化と、head_sha が変わっていなければ再計算しないキャッシュで大幅に削れる。
- **マイグレーションが全エラー握り潰し**(`core/db.ts:454-457` の `catch {}`)で、`user_version` も無い。本当に壊れた migration と適用済みの区別がつかない。`PRAGMA user_version` によるバージョン管理+失敗は fail-loud に。
- **DB が import 時シングルトン**(`core/db.ts:117-123`)。テストが env 変数と import 順序の規律に依存(AGENTS.md が回避策を明文化している時点で設計の匂い)。`openDb(path)` ファクトリ+デフォルトインスタンスの形に直すと、テスト・埋め込み・close ライフサイクルが素直になる。
- **同期 SQLite + `Atomics.wait` により、競合時は lh-web のイベントループ全体が最大 ~5 秒停止し得る**(`core/db.ts:27-65`)。単独ユーザーなら顕在化しにくいが、agent 複数並走(本来の使い方)で書き込みが重なると UI 全体が固まる。busy_timeout を短くして `withWriteRetry` 側に寄せるだけでも悪化を抑えられる。
- **worker の自動化面が使命に対して薄い**。対応イベント 2 種のみ・リトライなし・冪等性の表明手段なし・ステップは sandbox なしの `sh -c`(`worker/runner.ts:68`)。`lh dev` 側の精緻な sandbox 設計との落差が大きい。v1 として意図的(#52)なのは把握の上で、「AI エージェントのループ基盤」を名乗る中核なので優先度を上げる価値がある。

---

## 細かいが全体を良くする改善点

### 信頼性・安全性

- git の ref 引数に `--end-of-options` ガードが無い(`core/git.ts:44,142,221,274`)。`base_ref`/`head_ref` はユーザー入力由来なので `-` 始まりの ref がオプションとして解釈され得る。`gh` 側では `--` を使っており、意識はあるので横展開するだけ。
- `gh`/`git` の execFile にタイムアウトが無い(herdr は 15s あり、不統一)。auth プロンプトで固まった `gh` が無期限ブロックする。
- `-32603` エラーが生の `e.message` をクライアントへ露出(`web/server/rpc.ts:101`)。
- `--port foo` → `NaN` → ランダムポートで無言起動、`EADDRINUSE` はハンドラ無しで生スタック死(`web/server/index.ts:90`)。他フラグにはある `Number.isFinite` ガードの横展開。
- SSE がサーバ側 `id:` を出さず、`EventSource` の自動再接続では `since` が mount 時の値に固定(`web/src/lib/use-loophub-events.ts:43`)→ 長寿命接続の切断で全量リプレイのバースト。`id:` を出して `Last-Event-ID` に乗るのが正道。
- prepared statement キャッシュが無制限(`core/db.ts:79-92`)。動的 SQL(可変 IN 句など)で常駐 lh-web が際限なく成長し得る。

### 保守性

- `cli/index.ts` の `Flags` 型(~60 項目)と `parseArgs` options map の手動二重管理 + `strict:false`(未宣言フラグが黙って通る)。コマンド表駆動の登録形式にすれば両方消える。
- `core/config.ts` がアクセサ毎に `readFileSync + JSON.parse`(`core/config.ts:69-162`)、パースエラーも個別に握り潰し。mtime キャッシュ 1 枚で足りる。
- イベントのラベルフィルタが SQL(`core/store.ts:1530-1537`)と live 経路(`core/events-follow.ts:66-83`)で二重実装。
- `initialize` / capability negotiation は契約に定義済みだがクライアントが呼んでおらず、バージョン齟齬を検知する機会を捨てている。

### フロントエンド

- `pull-detail.tsx`(907 行)/`issue-detail.tsx`(653 行)が `CommentList`/`CommentForm`/ヘッダ scaffolding を各自定義。`<DetailShell>` / 共有 `<Comments>` / `<QueryBoundary>` の抽出で重複とロード状態のばらつきが同時に解消。
- SSE→invalidation の対応表(`web/src/lib/event-keys.ts`)は精密で優秀。ただし末尾の「repo を持つ全イベントで repo キー無条件 invalidate」(`event-keys.ts:145-148`)だけが鈍い。

### テストの穴(重要どころのみ)

- `core/service.ts`(直接テストなし)、`core/worktree-provision.ts`、`web/src/lib/use-loophub-events.ts`(SSE クライアント再接続/巻き戻し)、`cli/index.ts` の dispatch(2,024 行・テストなし)。
- e2e/ブラウザテストはゼロ。まずは CI(C2)が先。

---

## 推奨順位

1. **CI + 契約ドリフトゲート(C2)** — 1 日仕事で以降の全変更の安全網になる
2. **トランザクションヘルパー + `setMerged`/`deleteRepo`/`emitEvent` 同一コミット化(C1 + C4 の一部)**
3. **service.ts / store.ts の機械的分割(C3)** — エージェント並行開発の摩擦を直接減らす
4. **`/rpc` ボディ上限 + 非 loopback 時トークン(C5)**
5. 以降は「細かい改善点」を関連 issue 化して随時
