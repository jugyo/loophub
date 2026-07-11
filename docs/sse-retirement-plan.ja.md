# SSE 依存の調査と廃止計画

この文書は、SSE 廃止を実装・review する LoopHub 開発者向けの実行計画である。
最初に現在の event 経路と polling の成立根拠を確認し、その後の依存一覧と phase 順に
削除する。SSE 自体の削除や新しい transport の設計はこの文書の作業範囲に含めない。

source 参照は調査時点の `path:line` を補助情報として示す。後続実装では、本文に記載した
module / symbol 名で最新 source を検索し、行番号だけに依存せず挙動を再確認する。

## 結論

LoopHub の Web UI はすでに `GET /events` の SSE を使用しておらず、ルートで
`events/list` JSON-RPC を polling して TanStack Query の cache を invalidate している。
したがって SSE は、新しい push transport を導入せずに廃止できる。

廃止対象は、`GET /events`、lh-web 内の replay / live subscription と DB tail、
`lh events --follow`、クライアント側 SSE parser、`events/notify` の contract metadata、
および SSE を前提にした helper・test・documentation・comment である。通常の
`lh events` snapshot、永続 event store、`events/list`、Web UI の polling、worker の
event polling は SSE ではないため維持する。

この文書は commit `9c7c1fff` 時点の repository source と LoopHub issue #1157 を調査した
結果である。この Issue では削除を実装せず、後続作業の境界と検証方法を定義する。

## 現在の event 経路

### Web UI: 維持する polling 経路

1. mutation は event row を SQLite に永続化する
   (`core/store/events.ts:12-29`)。
2. `events/list` は `core/service/events.ts` の bounded snapshot を公開する
   (`web/server/contract.ts:1111-1128`)。
3. root route に一度 mount された `useLoopHubEvents` が、表示中は 1.5 秒、非表示中は
   5 秒間隔で `events/list` を呼ぶ (`web/src/routes/root.tsx:8-17`,
   `web/src/lib/use-loophub-events.ts:18-21,83-147`)。
4. 取得した event は `queryKeysForEvent` に渡され、該当する query cache を invalidate
   する (`web/src/lib/use-loophub-events.ts:38-46`)。

この経路に `EventSource`、`GET /events`、`events/notify`、`web/server/events.ts` は含まれない。

### SSE: 削除する互換経路

`GET /events` は、接続ごとに `web/server/events.ts` で永続 event を replay した後、
in-process event hub を subscribe する。lh-web process 外から SQLite に書かれた event を
live subscriber に届けるため、lh-web 自身も 1 秒間隔で DB tail を実行して event hub に
再 publish している (`web/server/events.ts:28-99`, `web/server/index.ts:8-23`)。
これは Web UI ではなく、現在は `lh events --follow` のために残っている互換経路である。

## Web UI polling の成立確認

| 観点 | 現在の動作と根拠 | 廃止前に固定する検証 |
|---|---|---|
| 更新通知 | poll で得た各 event を `queryKeysForEvent` に渡す。issue、PR、session、repo、workflow、inbox、notification 等の mapping は unit test 済み (`web/src/lib/event-keys.test.ts:17-218`) | `event-keys` と poller の test を継続する |
| cursor / replay | `localStorage` の last id から `id > since` を昇順で取得し、最大 id へ進める (`web/src/lib/session.ts:33-46`, `web/src/lib/use-loophub-events.ts:92,108-129`, `core/store/events.ts:31-65`) | 空 response 後も同じ cursor で再 poll する test と、100 件到達時に即時 drain する test を残す |
| visibility | `document.visibilityState` で 1.5 秒 / 5 秒を選び、`visibilitychange` で timer を再 schedule する (`web/src/lib/use-loophub-events.ts:96-105,135-145`) | hidden / visible の interval と listener cleanup を明示する unit test を追加する |
| DB rollback | 保存 cursor より DB の newest id が小さい場合、30 秒ごとの probe で cursor を戻し、広い query prefix を invalidate する (`web/src/lib/use-loophub-events.ts:48-80,112-121`) | `999` から `12` へ戻る既存 test を維持する (`web/src/lib/use-loophub-events.test.tsx:173-198`) |
| 複数タブ | 各 tab が独立した in-memory cursor で poll する。共有 `localStorage` の更新で、後発 tab の cursor が途中で飛ばない (`web/src/lib/use-loophub-events.ts:89-94`) | 7 tab がそれぞれ poll する test と、2 tab の cursor 独立性 test を維持する (`web/src/lib/use-loophub-events.test.tsx:55-89,127-171`) |
| error / unmount | RPC error 時も次回 poll を schedule し、unmount 後は timer と listener を破棄する (`web/src/lib/use-loophub-events.ts:130-146`) | error recovery test を追加し、unmount test を維持する (`web/src/lib/use-loophub-events.test.tsx:200-215`) |
| 全 route への適用 | poller は root route に mount され、UI catalog 以外の route を共通して更新する (`web/src/routes/root.tsx:8-21`) | root mount と代表的な issue / PR invalidate の integration test を維持する |

commit `8ae12a64`（#726）は Web UI の `EventSource`、Web Locks、`BroadcastChannel` による
tab coordination を各 tab の `events/list` polling に置き換えた。現状の source と tests は
この移行後の構成であり、SSE server を止めても Web UI の更新経路は変わらない。

不足しているのは機能ではなく regression test の一部である。特に visibility interval、
RPC error recovery、100 件を超える backlog の即時 paging は source 上は実装済みだが、
後続の削除 PR では SSE 削除前に明示的な test を追加して polling contract を固定する。

## 依存一覧

### 1. HTTP server / live delivery: 削除

| File | 役割 | 廃止時の扱い |
|---|---|---|
| `web/server/http.ts` | `/events` route、`text/event-stream` header、SSE frame、heartbeat、connection cleanup | handler、constant、import、route branch を削除する |
| `web/server/events.ts` | replay、repo filter、replay→live dedupe、in-process subscription、lh-web の DB tail | file 全体を削除する |
| `web/server/index.ts` | `startEventTail` の起動・停止、SSE を含む説明と poll-ms log | tail lifecycle を削除する。`--poll-ms` / `LOOPHUB_POLL_MS` が他用途を持たなければ同時に削除する |
| `core/event-hub.ts` | `LoopEvent` wire type / formatter と、SSE 用 in-process `subscribe` / `publishEvent` | pub/sub と listener test helper は削除する。型と formatter は `events/list` でも使うため、同 file に残すか transport-neutral module へ移す |
| `core/store/events.ts` | event 永続化後に in-process hub へ publish | SQLite insert は維持し、SSE 専用 publish と説明だけ削除する |

`web/server/events.test.ts` の先頭 5 tests は SSE replay / tail 専用なので削除する。同じ file の
pull sweep / usage sweep tests は worker maintenance の test であり SSE とは無関係なので、
適切な worker test file へ移して維持する (`web/server/events.test.ts:148` 以降)。
`web/server/http.test.ts:267-320` の `/events` integration test も削除対象である。
route branch を単純に消すと `/events` が SPA fallback へ入り 200 を返す可能性があるため、廃止後は
`GET /events` が明示的な 404 または 410 を返す contract にして test する。

### 2. CLI / core client: `--follow` のみ削除

| File | 役割 | 廃止時の扱い |
|---|---|---|
| `cli/commands/events.ts` | `flags.follow` の場合だけ SSE client を起動し NDJSON を流す | follow branch と SIGINT handling を削除し、snapshot branch を残す |
| `cli/args.ts` | `Flags.follow` と `follow: { short: "f" }` の宣言 | flag 宣言を削除し、旧 flag を明示的に拒否する guard を追加する |
| `cli/usage.ts` | `--follow` / `-f` の help と example | flag と example を削除し、snapshot の `--since` / `--repo` / `--label` / `--order` を残す |
| `core/events-follow.ts` | HTTP connect、basic auth header、SSE parser、label filtering、abort handling | file 全体を削除する |
| `core/events-follow.test.ts` | parser、label filter、HTTP / abort behavior | file 全体を削除する |
| `core/service/events.ts` | `events.follow` service procedure | `follow` のみ削除し、`list`、`emit`、`page`、`newestId` を残す |
| `core/service/shared.ts` | `FollowOptions` / `followEvents` の import と barrel export | follow 専用 import / type / export のみ削除する |

通常の `lh events` は shared SQLite を直接読む bounded snapshot であり、lh-web を必要としない
(`cli/commands/events.ts:38-46`, `core/service/events.ts:10-43`)。これは diagnostics、script、
履歴確認に有用で、SSE 廃止後も残す。`lh events --follow` の代替 push interface は追加しない。
継続的に待つ automation は worker の event polling、または各 consumer が bounded
`events/list` / service snapshot を cursor polling する。

`--follow` の削除は CLI breaking change である。release note と help で、snapshot を使う例
（`lh events --since <id> --order asc`）を示す。外部 script が `-f` を使っている場合は明示的に
失敗する必要がある。現在の parser は `strict: false` なので、宣言だけを消すと未知の `-f` を無視して
snapshot を実行する恐れがある。silent behavior change を避ける rejection test を追加する。
server endpoint より先に CLI flag を削除し、一つの release boundary を置ける構成にする。

### 3. Web client / contract metadata: 削除または修正

| File | 残っている依存 | 廃止時の扱い |
|---|---|---|
| `web/src/api/client.ts`, `web/src/api/client.test.ts` | 使用されていない `eventsUrl` と test | helper と test を削除し、`listEvents` は維持する |
| `web/src/lib/use-loophub-events.ts` | 使用されていない `EventNotification` / `applyLoopHubEventData` compatibility parser | wrapper parser を削除し、bare `LoopEvent` の処理を残す |
| `web/src/api/types.ts` | `LoopEvent` comment が SSE wire を記述 | type は維持し、`events/list` の wire type と記述する |
| `web/server/contract.ts` | `events/notify` capability と notification schema | notification metadata を削除し、`events/list` method は維持する |
| `docs/rpc-contract.json` | generated `events/notify` notification | contract generator の結果を再生成し、`events/list` は維持する |
| `web/server/rpc.test.ts` | initialize が `events/notify` を広告する assertion | notification assertion を削除または empty list contract に更新する |
| `web/vite.config.ts` | `/events` proxy と EventSource comment | `/events` を `API_PATHS` から外し、`/rpc` と `/attachments` を残す |

`events/notify` は SSE frame の payload metadata であり、`POST /rpc` に client から送られる
method ではない。SSE endpoint と共に削除できる。公開 contract の破壊的変更なので
`PROTOCOL_VERSION` を更新し、`npm run contract` で `docs/rpc-contract.json` を再生成する。

### 4. Documentation / comment cleanup

次の記述は runtime dependency ではないが、SSE 廃止完了時に現状へ合わせる。

- `AGENTS.md`、`README.md`、`web/README.md`: lh-web / live update architecture。
- `docs/workflow.ja.md`: `lh events -f` を起床 trigger とする手順。worker / bounded polling
  に置き換える。
- `web/server/dev.ts`、`web/server/rpc.ts`、`core/service/herdr-runner.ts`、
  `core/service/terminal.ts`: 「RPC/SSE」「SSE と同じ process」という説明。
- `core/dev.test.ts`、`core/service/dev.ts`、`core/service/handoffs.ts`、
  `web/src/queries/{workflows,workflow-runs,scheduled-tasks}.ts`、
  `web/src/lib/use-issue-keyboard-navigation.ts`: SSE-driven refresh という comment を
  event polling / query invalidation に修正する。
- `core/service/repos.ts`、`core/store/events.ts`、`worker/maintenance.ts`、
  `worker/runner.ts`: SSE replay / subscriber との比較を除き、実際に残る consumer を記述する。

comment の修正で event emission 自体を削除してはならない。これらの event は Web UI polling、
notification materialization、worker dispatch、audit history に引き続き使われる。

## SSE から独立して維持するもの

| Mechanism | 維持する理由 |
|---|---|
| SQLite `events` table と `emitEvent` | replay、audit、notification、worker、UI polling の共通 source of truth |
| `core/service/events.ts` の `list` | CLI snapshot と `events/list` の domain procedure |
| `events/list` JSON-RPC method と `listEvents` client | Web UI の active update transport |
| `LoopEvent` wire shape と DB row formatter | `events/list` が返す transport-neutral wire data |
| `events.page` / `events.newestId` | worker の bounded cursor loop が使用 (`worker/runner.ts:238-282`) |
| worker cursor file / polling / dispatch | workflow と automation の resident consumer。SSE subscriber ではない |
| notification source cursor | notification materialization が event / review history を独立して読むための DB cursor。browser cursor ではない |
| `queryKeysForEvent` と event emission call sites | Web UI の機能別 refetch と notification / audit を成立させる |

特に `events.page` を「SSE replay helper」とみなして削除してはならない。worker が同じ bounded
page primitive を使用する。逆に `web/server/startEventTail` は event hub へ republish するためだけの
lh-web loop なので削除できる。

## #1157 と既存作業の扱い

#1157「SSE replay に backpressure と中断可能なページングを導入する」は、遅い SSE client に
対する無制限 peak memory を改善する Issue だった。Issue は closed、PR #1162 も unmerged のまま
closed である。Web UI は #726 で polling へ移行済みであり、SSE 自体を廃止する方針では
backpressure 実装を追加する価値がない。

したがって #1157 / PR #1162 は再開・merge せず、履歴として closed のまま残す。今後同種の
SSE heartbeat、replay、backpressure、reconnect 強化 Issue は作成せず、SSE 廃止 Issue に
duplicate / superseded として集約する。ただし削除が長期間延期され、`GET /events` をその間も
support すると明示的に決定した場合だけ、#1157 の risk を再評価する。

## 段階的な廃止計画

### Phase 0: polling contract を固定する

- visibility、RPC error recovery、100 件超 backlog の unit tests を追加する。
- `events/list` の ascending cursor、repo filter、limit と rollback probe の tests を緑にする。
- baseline として `npm test`、`npm run typecheck`、`npm run lint` を記録する。

この段階では公開 interface を変えない。問題があれば test commit を revert するだけでよい。

### Phase 1: CLI follow consumer を廃止する

- `lh events --follow` / `-f` と `events.follow` を削除する。
- `core/events-follow.ts` と専用 tests を削除する。
- snapshot の filter / order / JSON output tests を維持し、help と workflow docs を更新する。
- release note に breaking change と cursor snapshot 例を記載する。

この段階では `/events` を残すため、CLI rollback は Phase 1 commit の revert だけで可能である。
外部 consumer の申告があれば endpoint の removal を止めて compatibility を判断する。

### Phase 2: server SSE endpoint と live hub を廃止する

- `/events` handler、heartbeat、`web/server/events.ts`、lh-web DB tail を削除する。
- `events/notify` capability / contract metadata と Vite `/events` proxy を削除する。
- JSON-RPC protocol version を更新し、`npm run contract` で artifact を再生成する。
- `core/event-hub.ts` の pub/sub 部分と `emitEvent` の in-process publish を削除する。
- `LoopEvent` / formatter、persistent store、`events/list`、worker page / cursor は維持する。
- `core/event-hub.test.ts` は formatter test を移設して維持し、pub/sub 専用 tests だけ削除する。
- SSE 専用 tests を削除し、混在している worker maintenance tests を移動して残す。

DB schema / data migration はない。rollback は Phase 2 commit の revert で endpoint と hub を戻せる。
Phase 1 と Phase 2 を別 commit / PR にすると、CLI consumer の互換性確認後に server を安全に外せる。

### Phase 3: residue cleanup と最終検証

- dead helper、type、documentation、comment を更新する。
- contract JSON を再生成し、全 test / typecheck / lint を実行する。
- lh-web 起動後、`POST /rpc` の `events/list` が event を cursor 順に返し、Web UI の issue / PR
  更新が poll interval 内に反映されることを手動確認する。
- `GET /events` が SSE として公開されないこと、`lh events --follow` が help に出ないこと、通常の
  `lh events` snapshot と worker dispatch が動くことを確認する。

UI の見た目を変える計画ではないため screenshot は必須ではない。実装 PR では network trace
または RPC response、CLI snapshot、worker dispatch log を evidence とする。

## 互換性と rollback の注意点

- `/events` と `lh events --follow` は公開 interface なので、削除は semantic breaking change として
  release note に記載する。repository 内には Web UI 以外の endpoint consumer は CLI follow しかない。
- `events/notify` を contract から消すと、capability negotiation を見る外部 client に影響する。
  method list の `events/list` は変えない。
- `lh-web --poll-ms` / `LOOPHUB_POLL_MS` は SSE DB tail 専用なので Phase 2 で不要になる。外部 startup
  script が option を渡している可能性を release note に含める。worker 側の同名 poll setting は
  独立した event dispatch に必要なので削除しない。
- event rows と cursor values は削除しないため data rollback は不要である。各 phase は schema migration
  を含めず、問題が起きた phase の commit を revert する。
- rollback 中に event id は増え続けても `id > since` semantics は維持される。DB restore で id が戻った
  場合は Web UI の rollback probe が cursor を下げる。

## 完了判定の検索条件

廃止後は、case-insensitive な一般語検索と、symbol / route の検索を両方実行する。

```sh
rg -n -i '\bSSE\b|server.sent|EventSource|text/event-stream|event-stream|SSE parser' \
  --glob '!node_modules' --glob '!.git' .

rg -n 'GET /events|/events\b|eventsUrl|events/notify|subscribeEvents|startEventTail|followEvents|createSseParser|FollowOptions' \
  --glob '!node_modules' --glob '!.git' .

rg -n -- '--follow|-f\b' cli docs README.md web/README.md
```

期待値は次のとおり。

- SSE protocol / endpoint / parser / notification の hit は 0 件。
- `/events` の hit が残る場合、`events/list`、event domain noun、または attachment 等の別 route で
  あることを一件ずつ確認する。bare `/events` endpoint の hit は 0 件。
- `--follow` / `-f` は別 command の option との false positive を確認し、`lh events` 用は 0 件。
- historical commit message や、この廃止記録を repository に残す場合は allowlist を明示する。
  「実装に不要な記述が 0 件」という判定を、調査記録自身の語句で失敗させない。

最後に以下を実行し、削除で shared event mechanism を壊していないことを確認する。

```sh
npm test
npm run typecheck
npm run lint
npm run contract
lh events --repo <owner>/<repo> --order desc --json
```
