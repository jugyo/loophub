# Execute / Verify workflow — ポインタ入力と HEAD/review 観測による親子協調

> Status: Implemented · Issue: #975 / #981 / #1284 / #1307 / #1358 / #1555 / #1556 / #1680 / #1697 / #1712
>
> 本書は、特定の skill を必須とせずに開発 workflow を実行するモデルを定義する。step は
> **Execute / Verify の 2 つに固定**し、ユーザーが設定できるのは各 step に与える prompt だけである。
> #1358 で **artifact 契約と入力合成機構を廃止**し、エージェント間の情報交換を次の 2 原則へ統一した。

- **fact はドメイン状態に書く** — 完了・commits・review などの事実は event / git / DB に記録する。
  エージェント間の直接メッセージ（提出物・artifact）は存在しない。
- **instruction は injection で配達する** — agent への入力は起動プロンプト、または生きている pane
  への注入で届ける。**live な子への操作**は parent が Herdr を直接使い、テキスト注入は
  `herdr pane run`、実 Esc 入力は `herdr pane send-keys <pane_id> Escape` で行う（lh CLI の
  ラッパーを挟まない）。子の**起動**は `lh workflow launch-step`、**観測**は
  `lh workflow step status` のまま。event 到着待ちは runtime-managed background task として実行する
  blocking `lh workflow watch` が担い、task completion で同じ親が再開する。子は親の pane・topology を
  知らない。
- **rework / 継続作業は同じ Execute セッションを優先する**（#1556）— live な executor pane があれば
  parent が `orchestrator:` を注入し、毎回 fresh Execute を起こさない。注入直前に
  `activate-step` でその Execute session を live control 対象として記録する。pane が無い・解決できない・
  session を特定できない・注入失敗のときだけ `launch-step` で fresh 起動する。**Verify は常に
  fresh child**（注入で再利用しない）。注入するかどうかの判断は parent contract に置き、engine
  には持たせない。

idle 状態の検知は、状態遷移や完了判定のどこにも使わない。

## 1. 目的と前提

LoopHub は手順の骨格と step contract を所有し、ユーザーは contract の範囲内で各 step の働き方だけを
prompt で設定する。workflow を起動する前提は次のとおり。

- **人間が issue の title / body / comments を確認し、実装に必要な背景・done 条件・acceptance
  criteria・scope が十分に書かれていると判断してから起動する。**
- Execute agent はドメインを知る pull 型開発者である。issue・PR・review を lh CLI で自分で読み、実装
  計画も自分の session 内で立てる。人間は実行中の pane へ介入して計画を確認・変更できる。
- Verify agent は Execute とは別の fresh session で、(issue 参照, base SHA, head SHA) の 3 ポインタが
  指す固定 diff を独立検証する。PR body・実装者の説明は読まない。
- workflow agent（親）は残す。親はコードを書かず、子の起動、HEAD / review 観測に基づく遷移、rework、
  停滞時の人間への escalation を担当する。

## 2. 情報の流れ

| 経路 | 情報 | 媒体 |
|------|------|------|
| 親 → Execute | input: issue / PR の参照。rework 時は対応すべき review の id | 起動プロンプト、または生きている pane への注入（instruction） |
| Execute → 世界 | commits、PR body・attachment・comment | git / domain（lh CLI で自分で読み書き） |
| Execute → 親 | ターン完了の宣言（payload なし） | `lh workflow turn done` が event を記録（fact）。runtime-managed watcher の完了結果から親が event batch を観測 |
| 親 → Verify | input: (issue 参照, base SHA, head SHA) の 3 ポインタ | 起動プロンプト。合成ファイルなし |
| Verify → 世界 | pass / request_changes ＋ findings | head SHA に pin された PR review（fact） |
| 世界 → 親 | turn done、workflow review 登録、GitHub PR feedback の観測 | blocking watcher が返す昇順 batch。観測後に domain state を再確認 |
| Verify ↔ Execute | 直接のやりとりなし | diff と review という domain object 経由 |

```text
[Web / CLI]
  人間が確認済みの issue で workflow を開始
            │
            ▼
  workflow agent（親）
    │  runtime-managed watcher が返した turn_done / review_submitted / github_feedback の
    │  event batch を処理し、domain state を再観測して遷移する
    │
    ├─ Execute child を起動（input: repo / issue / pr のポインタ）
    │    責務: 計画 → 実装 → テスト/evidence → 振り返り
    │    出力: commits + 通常の PR body / attachment / comment 操作
    │    宣言: `lh workflow turn done`（payload なし）
    │
    ├─ turn done ＋ HEAD 前進を観測 → Verify child を fresh 起動
    │    input: (issue 参照, base SHA, head SHA)
    │    出力: head SHA に pin された PR review
    │
    ├─ request_changes review → 生きている Execute pane へ「review <id> に対応せよ」を注入 → fresh Verify
    └─ fresh pass review → run は running のまま background watcher を再開
         ├─ 追加指示 → Execute pane へ注入（閉じていれば --note 付き launch）
         ├─ turn done ＋ HEAD 前進 → fresh Verify
         ├─ turn done ＋ HEAD 不変 → pass は fresh のまま待機
         └─ 明示的 stop → run を恒久終了（merge は人間）
```

## 3. アクターと責務

### 3.1 workflow agent（親 = 観測とポインタ配達に徹する orchestrator）

1. Execute 起動後、`lh workflow watch --repo <repo> --run <run> --json` を agent runtime 管理の
   background task として開始する。CLI が durable cursor を所有し、未 acknowledge の run event を昇順
   batch で返す。task completion で同じ親が再開し、`lh workflow step status` などの domain state を再観測
   して遷移する。task completion と event は timing signal であり、完了や verdict そのものではない。
2. `lh workflow launch-step` で Execute / Verify child を起動する（engine が input ポインタを解決）。
   出力の `agent` 行（Herdr name、例: `executor #<run>-<seq>`）を記録し、`herdr agent get` で
   `pane_id` を解決して注入先として使う。parent 再起動で agent name を失った場合は
   `herdr agent list` から当該 run の最新 `executor #<run>-*` を引き直す。
3. **遷移は「turn done event の観測 → `lh workflow step status` で HEAD / review 状態を観測」で決める。**
   宣言はタイミングの合図であり真実を代替しない。宣言があっても HEAD が前進していなければ Verify を
   起動しない。pane 出力・子の自己申告・idle 検知・**注入の成功自体**は遷移判断に使わない。
4. `lh workflow run advance-to-verify | request-rework | await-human | resume` の意図ベース command で
   通常の lifecycle を遷移する。`current_step` はこの lifecycle を表す。一方、
   `active_step` / `active_session_id` は実際に操作中の child を表し、fresh launch の確認時と
   live Execute 注入直前の `activate-step` で更新する。live な子への注入 / Esc は herdr
   直接操作であり、`activate-step` 自体は lifecycle を遷移しない。コスト超過後の継続許可時だけは、
   lifecycle の resume より先に専用の `increase-cost-limit --expected-limit <usd>` を実行する。
5. request_changes / 継続指示 / merge conflict は **同じ Execute 注入経路** を使う。最新 Execute
   child とその登録済み session id を解決し、注入前に
   `lh workflow run activate-step --step execute --session <session_id>` を成功させる。
   `pane_id` が得られれば `agent_status: done` でも同じ pane へ **1 行の**
   `orchestrator: ...` を `herdr pane run` で注入する（改行・制御文字は空白へ潰す）。rework は
   `orchestrator: address review #<id>` のみ（findings の要約・解釈はしない）。agent を解決できない、
   session を特定できない、`pane_id` がない、または注入に失敗した場合だけ `launch-step`
   （`--review` / `--note`）で fresh relaunch する。fresh launch の確認は active step/session も
   自動記録する。修正後の Verify は常に fresh child とする。
6. コスト上限超過では event payload の `usage_session_id` と `active_step` /
   `active_session_id` を区別し、run を needs-human hold にしてから active child の pane だけに
   実 Esc と理由通知を送る。yes / no の続行確認は一度だけ表示する。解消不能状態も issue comment +
   Inbox + needs-human 状態で人間へ渡す。
7. passing verdict 後も run と runtime-managed watcher、および可能なら Execute pane を維持し、追加指示や
   turn-done を待つ。run を恒久終了する command は無く、終了させるのは人間である。merge はしない。

親は idle 検知を使わない（`herdr agent wait --status idle` を使わない）。注入前に子の idle を待たない。
rework は通常 Execute の turn done 後に届く。継続指示が作業中に来ても注入する（Esc は
`workflow_run.cost_exceeded` のときだけ）。親はコード・review・PR を直接編集しない。

### Runtime-managed watcher protocol

初回は Execute 起動後、agent runtime の background-task option で次の blocking command を開始し、親の
model turn を終了する。shell の background 化や pane への wake 注入は行わない。

```sh
lh workflow watch --repo "$repo" --run "$run" --json
```

task completion で同じ親が再開し、JSON の `events` を昇順に処理する。array は正確に 1 event を含み、
acknowledgement を event-level checkpoint にする。各 transition は
`lh workflow step status` が返す HEAD / review 状態から決める。batch 全体を処理した後だけ、返された
`cursor.delivered` を次の watch で acknowledge する。

```sh
lh workflow watch --repo "$repo" --run "$run" --ack "$delivered_cursor" --json
```

CLI は run ごとの `event_ack_cursor` と `event_delivered_cursor` を DB に保持する。ack 前に親が停止すれば
同じ event を replay し、ack 後は block 前に次の event を確認する。このため transition command が生成
した `workflow_run.updated` も次の wait で即時取得できる。

Esc、pane 通知、Issue comment、Inbox のような DB transaction 外の side effect は、実行前に durable
receipt を claim し、成功後に complete する。

```sh
lh workflow effect begin --repo "$repo" --run "$run" --event "$event" --effect "$key" --json
lh workflow effect complete --repo "$repo" --run "$run" --event "$event" --effect "$key" --json
```

`begin` が `execute: true` を返した場合だけ effect を実行する。停止後の replay で receipt が `pending`
なら、effect 済みか否かを自動判定できないため再実行せず、人間へ曖昧状態を可視化する。pending receipt が
残る event の ack は拒否される。これにより「effect 実行後、complete / ack 前に停止」の境界でも二重通知を
発生させない。event 読み取りや待機が失敗した場合も non-zero exit を可視化し、retry や fallback delivery
は行わない。

deterministic test は event reader と待機を差し替え、空結果から非空 batch への遷移、ack 前の replay、
直前に配信した event だけを受け付ける checkpoint 境界、transition 後の即時 batch を検証する。

```sh
npm test -- core/service/workflow-watch.test.ts cli/workflow-watch.test.ts
```

core test が検証する poll query は毎回次の filter である。

```text
since=<durable-ack> repo=jugyo/loophub types=[workflow_run] runId=42 order=asc limit=1
```

CLI integration test は実 DB と別 process からの event 記録を使い、blocking watcher の task completion、
JSON batch、effect 実行後かつ ack 前の停止を確認する。不正引数と依存 failure は非0で可視化する。
さらに production agent runtime の background-task completion から同一 parent invocation へ戻る境界は、
認証済み Claude Code を使う opt-in integration test で確認できる。

```sh
LOOPHUB_LIVE_AGENT_RUNTIME=claude-code npm test -- cli/workflow-watch.runtime.test.ts
```

### 注入 round の監査

`activate-step` はコスト中断対象を正確にする live-control safety command であり、lifecycle を遷移せず、
監査専用でもない。注入 round 自体は既存の domain fact だけで追え、監査専用の lh コマンドは追加しない。

- `lh workflow run request-rework` が `rework_count` を増やす。
- Execute の各ターンは `workflow_run.turn_done` event を残す。
- 注入成功時は `step_sessions_json.execute` に既に記録済みの **同一 session** が使われる
  （`launch-step` を呼ばないため execute session id は増えない）。注入失敗後の fresh launch だけが
  新しい execute session id を追加する — これが「同じセッション継続」と「再起動」の差になる。

### 3.2 Execute agent（ドメインを知る pull 型開発者）

1. `lh issue view` / `lh pr view` で issue・PR（rework 時は対応すべき review）を自分で読む。
2. 関連コードを見て最小の実装計画を session 内に持つ（独立 artifact として提出しない）。
3. 実装し、repo 標準の test / lint / typecheck を green にする。
4. 結果を **ドメイン状態** に書く: commits、`lh pr update` による PR body、`lh attachment add`、
   `lh pr comment`、draft の場合は `lh pr ready-for-review`。
5. ターン完了を `lh workflow turn done`（payload なし）で宣言する。**commit 前に宣言しても run は
   進まない**（親が HEAD 前進を観測しないため）。

`orchestrator:` 注入や launch 時の `--note` で届く **追加作業指示**（rework 以外の human note /
continuing instruction など）は、自然に Issue / PR への追加要望と読めるならそのように扱い、同じ
issue・PR に対して実装する。完了後は通常の Execute と同じく **commit（ドメイン変更がある場合）→
必要なら PR body / comment / attachment の更新 → `lh workflow turn done`** に戻る。rework
（`address review #<id>`）は review 対応であり追加要望とは別だが、どちらも完了後の経路は同じ。
質問のみ・判断待ちは escalate して同 pane で待機し、確認のみや HEAD を進めない更新（PR body 等）は
commit せず turn done してよい（親は HEAD 不変なら既存 pass を維持し、HEAD 前進時だけ fresh Verify
する）。issue body への追記は必須ではない。

### 3.3 Verify agent（固定ポインタの独立検証者）

launch 時に (issue 参照, base SHA, head SHA) を受け取り、`git diff <base>..<head>` を自分で計算して
その固定 diff だけをレビューする。レビュー範囲をその diff から拡張せず、PR body・実装者の説明は
読まない（PR 番号は review の提出先としてのみ与えられる）。source は編集せず、必要なテストは実行できる。
出力は `lh pr review --topic workflow --commit <head sha>` による、head SHA に pin された PR review
（pass / request_changes）のみ。毎回 fresh session で起動される。

### 3.4 非対称性は意図的な設計判断

「Execute = pull・ドメインアクセスあり / Verify = 固定ポインタ・PR メタ非参照」という非対称性は、
検証の独立性を、変更がどう説明・フレーミングされたかから切り離すための意図的な選択である。Verify を
pull 型にして「対称化」することは独立性境界を壊すため明示的に禁止する。

## 4. workflow 定義

workflow は global な prompt bundle として DB に保存する（Execute prompt / Verify prompt の 2 つ）。

```sql
CREATE TABLE workflows (
  id, name, description, execute_prompt, verify_prompt, created_at, updated_at
);
```

- prompt は plain markdown。空文字は built-in contract だけで動くことを表す。
- Settings の Workflows UI は Execute prompt / Verify prompt の 2 textarea を表示する。
- RPC / wire type は `execute_prompt` / `verify_prompt` のみを公開する。

run の current step は `execute | verify` のみで、新しい run は `current_step: execute` で始まる。

## 5. 出力とその観測

出力 artifact 契約（execution-report / verdict）は廃止した。出力は既存ドメイン語に解消される。

| step | 出力 | 完了の観測 |
|---|---|---|
| Execute | commits + 通常の PR body / attachment / comment 操作 | HEAD が base より先行し、最新 review が指す SHA より前進している |
| Verify | head SHA に pin された PR review（topic `workflow`） | 最新 review が current HEAD に pin されている（fresh） |

`lh workflow step status <run> --json` は観測結果を返す: current HEAD、HEAD が base より先行しているか、
最新 turn-done 宣言の時刻、各 step の状態（Verify は最新 workflow review の id / event / **fresh**）。
これが遷移判断の唯一の根拠である。

### 検証 freshness

freshness は review の pin された head_sha と current HEAD の比較だけで導出する。current HEAD に対する
pass 後、新しい commit で HEAD が進んだ場合は既存 review が stale となり fresh Verify が必要になる。
一方、PR body・comment・attachment だけの更新は HEAD を変えないため、既存 pass は fresh のままである。
Workflow 専用の freshness / dirty / checkpoint 状態は追加しない。

## 6. 完了宣言（turn done）

Execute は `lh workflow turn done`（payload なし）でターン完了を宣言する。情報不足や人間の判断が必要な
場合は、質問全文を自分の pane に提示し、`lh workflow escalate --reason <short summary>` を宣言して、
同じ pane で人間の回答・指示を待つ。reason は `await-human` と同じ inline text（必須、最大 500 文字）
であり、質問内容の短い要約を入れる。engine はこれらをそれぞれ `workflow_run.turn_done`、
`workflow_run.escalated` event として
記録するが、escalate 自体は run lifecycle を変更しない。Verify が review を登録すると
`workflow_run.review_submitted`、GitHub PR feedback が同期されると `workflow_run.github_event` が記録
される。usage sweep が run の累積コスト上限越えを検知すると、edge-triggered に一度だけ
`workflow_run.cost_exceeded` が run・累計上限ごとに1回だけ記録される。run 開始時には設定された
上限を固定増分 `B` と初期累計上限 `B` の両方として保存するため、その後の設定変更は既存 run に
影響しない。payload には `cost_usd`、`limit_usd`、`increment_usd`、`next_limit_usd` が含まれる。
`usage_session_id` はコスト更新を検知した
usage 集約であり、中断対象ではない。中断対象は別フィールドの `active_step` /
`active_session_id` である。passing Verify 後の追加 Execute 中も `current_step` は Verify のままだが、
注入直前の `activate-step` により active target は Execute になる。親はその step の最新 child pane を
解決し、まず run を `await-human` で hold してから
`herdr pane send-keys <pane_id> Escape` で実 Esc を送り、同じ pane に
`orchestrator: Cost limit exceeded: current $<cost>, limit $<limit>. Wait for human instruction.`
という 1 行を一度だけ通知する。`herdr pane run <pane_id> Escape` は文字列 `Escape` を入力するため
使わない。その後、親 pane に「続けますか？」という yes / no の確認を同じ event id につき一度だけ
表示する。親は watcher が返した run-scoped batch でこれらを処理する。CLI の filter は payload の `id`
を使って対象 run に絞り込む。子の contract に親の pane id や topology は現れない。

yes の場合は、まず `lh workflow step status` で current HEAD / review / step を再観測し、
`lh workflow run increase-cost-limit --run <run> --expected-limit <limit_usd>` で累計上限を固定増分 `B`
だけ増やす。この操作は run が human hold 中で、期待上限が DB の現在値と一致し、その上限に対応する
cost exceeded event がある場合だけ原子的に成功する。成功後に限り `resume --step <active_step>` で
hold を解除する。通常の resume 自体は上限を変更しない。Execute は同じ pane へ domain state 再確認を含む
1 行指示を注入して続行し、Verify は中断した子を再利用せず current HEAD に対する fresh child を
起動する。no の場合は hold を維持し、注入・step 遷移・子起動をせず次の明示的な人間指示を待つ。
確認待ちと `Continuation decision: yes|no` は親 pane に表示する。pane 解決、hold、Esc、通知、確認
表示のいずれかに失敗した場合は成功扱いせず、親 pane・issue comment・Inbox に command と error を
残して hold を維持する。同じ edge の再処理で暗黙 retry や通知・確認の重複を行わない。

5 種類の通知はいずれも真実を代替しない timing signal である。親は通知後に
`lh workflow step status`、PR review、または参照された GitHub API resource から domain state を再観測して
判断する。review の verdict や feedback 本文を通知 payload の複製で判断しない。idle 検知は完了推定に
一切使わない。

## 7. 親の遷移

| From | 観測条件（step status） | Action |
|---|---|---|
| start | run started | Execute を launch → runtime-managed watcher を background task として開始 → 親 turn 終了 |
| Execute | HEAD が base より先行し、最新 review より前進 | `advance-to-verify` → Verify を fresh launch |
| Execute | `workflow_run.escalated` を受領 | event の reason を再取得し、`await-human` で hold |
| Execute / Verify | `workflow_run.cost_exceeded` を受領 | active child を解決 → `await-human` → 実 Esc + 1 行通知 → yes / no を一度だけ確認 |
| Cost confirmation | yes | `step status` を再確認 → 期待上限付き専用操作で `B` 増額 → hold を解除。Execute は同じ pane で続行、Verify は current HEAD に fresh launch |
| Cost confirmation | no | hold を維持し、子起動・注入・自動遷移を行わず次の明示的指示を待つ |
| Human wait | Execute の turn done 後、HEAD が最新 review より前進 | `resume --step execute` → 通常の Execute 完了遷移 → fresh Verify |
| Human wait | Execute の turn done 後、HEAD が不変 | hold を維持し、追加作業または明示的 resume を待つ |
| Verify | 最新 review が fresh + pass | run を `running` のまま維持し、処理済み cursor を ack して次の watcher task で追加指示・turn-done を待つ |
| Verified + continuing | 人間が追加作業を指示 | `run resume` は使わず、既存 Execute pane へ `herdr pane run` で注入する。pane が閉じていれば `--note` 付きで Execute を launch |
| Verified + continuing | Execute の turn done 後、HEAD が passing review より前進 | run は Verify のまま、現在の HEAD に対する Verify を fresh launch |
| Verified + continuing | Execute の turn done 後、HEAD が不変 | 既存 pass は fresh のまま。Verify を起動せず待機を続ける |
| Verify | 最新 review が fresh + request_changes | rework → Execute |

fresh pass は現在の HEAD を検証するが、run を完了・凍結しない。親の runtime-managed watcher と Execute pane を維持し、
同じ run で追加作業を受け付ける。追加指示時に run は人間待ち hold ではないため `run resume` を使わない。
生きている Execute pane へ parent が `herdr pane run` で `orchestrator: <instruction>` を注入し、
pane が閉じている場合は `lh workflow launch-step --step execute --note <instruction>` で起動する。
その後の turn done で HEAD が進んでいれば fresh Verify を起動し、PR body・comment・attachment だけが
変わって HEAD が不変なら既存 pass を fresh のまま維持する。run を恒久終了する command は無く、
終了させるのは人間である。

rework 上限は 3。最新 Execute child に対する `herdr agent get`（必要なら `herdr agent list` で
agent name を再発見）が成功して `pane_id` を返す場合は、`agent_status: done` でも pane は再利用可能
と扱い、新規 launch より先に parent が **1 行の** `herdr pane run` で
`orchestrator: address review #<id>` の注入を試す（同じ Execute セッションで対応する）。agent を
解決できない、`pane_id` がない、または注入に失敗した場合に限り `--review <id>` で Execute child を
再 launch する。修正後の Verify は常に fresh child とする。注入の成功自体を execute complete の根拠
にしない — 次の遷移は `lh workflow step status` の HEAD / review 観測のみ。

宣言がないまま run 活動が停止しても、worker が時間経過だけで run を自動ホールドすることはない。進捗の
有無は turn done と HEAD / review を観測する parent が扱い、本当に死んだ run は人間が気づいて stop /
resume する（人間がリカバリ可能な失敗に自動機構を足さない原則）。rework 上限・escalation・
人間による resume は引き続き機能する。新規に到達し得る run の status は `running` のみ
（人間待ちは `running` のまま needs_human_reason を持つ）。`completed`（#1513）と `stopped`（#1525）は
legacy status で、いずれも書き込み経路は削除済み。古い DB 行として残り得るため UI / serialize は
read-only 表示だけ維持する。

fresh pass 後も run は complete せず `running` + `verification_status: verified` のまま保つ。run を恒久
終了する command は無い。コスト超過時は parent が needs-human hold を先に設定し、
`herdr pane send-keys <pane_id> Escape` で active child だけを中断してから yes / no を確認し、
人間の yes なしには増額も再開もしない（child の Esc 送信自体に lh CLI ラッパーは無い）。
`resume` は `await-human` による明示的 hold を人間の指示で解除する command であり、fresh pass 後の
追加作業には使わない。

## 8. CLI

```sh
lh workflow create <name> [--execute-prompt <text>] [--verify-prompt <text>]
lh workflow update <name> [--step execute|verify --file <path|->]
lh workflow start <issue> --workflow <name>
lh workflow launch-step --run <id> --step execute|verify [--review <id>] [--note <text|->]
# lifecycle command
lh workflow run advance-to-verify|request-rework|await-human|resume --run <id>
lh workflow run increase-cost-limit --run <id> --expected-limit <usd>
# live control target（lifecycle step は変更しない）
lh workflow run activate-step --run <id> --step execute --session <session_id>
lh workflow turn done [--run <id>]          # Execute child がターン完了を宣言（payload なし）
lh workflow escalate --reason <text> [--run <id>] # Execute child が人間の判断の必要性を宣言
lh workflow watch --repo <repo> --run <id> [--ack <cursor>] --json # runtime-managed blocking wait
lh workflow step input <run> <step>         # 合成した contract + input ポインタ + prompt を dry-run
lh workflow step status <run> --json        # HEAD/base・最新 turn-done・最新 workflow review の freshness を観測
# live child control（parent が herdr を直接叩く。lh ラッパーは無い）
herdr agent get <agent name>                # launch-step の agent 行から pane_id を解決
herdr agent list                            # parent 再起動後に executor #<run>-* を再発見
herdr pane run <pane_id> 'orchestrator: ...'  # live な子へ 1 行の指示を注入（改行・制御文字は潰す）
herdr pane send-keys <pane_id> Escape       # コスト超過時に active child へ実 Esc を送る
```

`lh workflow step output` は廃止した。Verify の出力は `lh pr review --topic workflow --commit <sha>`
を用いる。

## 9. 廃止と移行

- `execution-report` / `verdict` の型・validation・placement・placement claim・retry、および PR body /
  review への自動配置処理を active path から取り除いた。`lh workflow step output` は廃止。
- 旧テーブル `workflow_artifacts` / `workflow_placements` / `workflow_step_pins` /
  `workflow_artifact_submitters` は、既存 DB では **履歴としてそのまま残す**（削除・変換しない）。
  新しい run はこれらを一切参照しないため、旧データが新しい run の進行条件になることはない。fresh
  install ではこれらのテーブルを作成しない。一時ロック用の `workflow_placement_claims` のみ DROP する。
- CLI・RPC / wire type・Web UI・run history・本書から artifact 契約前提の API・表示・用語を削除した。
  Workflow 専用の語彙として残るのは **input**（起動時に子へ渡すポインタ群）のみである。

## 10. 実装境界

| 層 | 責務 |
|---|---|
| `core/workflow/contracts/` | parent / Execute / Verify contract |
| `core/workflow/compose.ts` | contract render と「ポインタ + step prompt」の launch prompt 合成 |
| `core/workflow/steps.ts` | HEAD / review 観測から 2 step の状態を導く pure query |
| `core/service/workflow-runs.ts` | run start、child launch、turn done、status、rework |
| `core/service/workflow-watch.ts` | run-scoped blocking wait、batch delivery、ack validation |
| `core/store/workflows.ts` | 2 prompt と watcher cursor の persistence |
| `core/serialize.ts` | workflow / run の wire shape |
| `cli/commands/workflow.ts` | thin CLI |
| `web/src/components/workflow-run-status.tsx` | Execute → Verify tracker と最新 review 表示 |

## 11. 検証観点

- 「Execute → turn done → Verify pass → running のまま追加指示を待機」「追加指示 → Execute 注入または
  `--note` 付き launch → HEAD 前進時だけ fresh Verify」「request_changes → rework 注入（review id のみ、
  同じ Execute セッション優先）→ turn done → fresh Verify pass」「pane 無し時だけ fresh Execute
  launch」「注入テキストは 1 行」「注入成功は遷移根拠にしない」「宣言なしタイムアウト → 人間へ可視化」
  「明示的 stop」の基本フローが artifact なしで決定的に進行する。
- rework 注入 round が `rework_count` + `workflow_run.turn_done` + `step_sessions_json.execute` の
  同一 session で監査でき、監査専用コマンドが不要である。
- Execute input が issue / PR / (rework 時) review id のポインタのみで、`task.md` / `findings.md` が
  生成されない。
- Verify input が (issue 参照, base SHA, head SHA) のみで、`changes.diff` / `report.md` /
  `prior-verdicts.md` が生成されない。
- status は HEAD / base / 最新 review の freshness を返し、head advance で pass が stale になる。
- PR body・comment・attachment だけの更新では pass が fresh のまま維持される。
- 親は turn done、review submitted、GitHub feedback の event を runtime-managed watcher の昇順 batch
  として処理し、その都度 domain state を再観測する。blocking wait 中に親 model turn は発生しない。
- 親 rollout と同じ累積 token counter prefix を引き継ぐ fork 子 2 本を集約しても prefix は 1 回だけ
  加算され、各子は fork 後の増分だけになる。
- `workflow_run.cost_exceeded` は usage 更新元と active step/session を別フィールドで記録し、親は
  fresh launch または注入直前に記録した active pane を hold 後に
  `send-keys ... Escape` で中断し、1 行通知を一度だけ送る。
- fresh pass 後の追加 Execute では `current_step: verify` を維持しつつ
  `active_step: execute` / 当該 session を記録し、コスト超過時に verifier ではなく executor を止める。
- コスト続行確認は yes / no を一度だけ表示し、yes は step status 再確認後、期待する現在上限を指定した
  専用操作で固定増分 `B` だけ増額してから再開する（Verify は fresh child）。重複操作や古い event、
  通常 hold に対する増額は非0で拒否され、通常 resume は上限を変えない。no は増額も自動進行もせず、
  操作・確認失敗は可視な error として残る。
- idle 検知が遷移・完了判定に使われない。
- 旧 artifact テーブルが新しい run の進行条件にならない。
