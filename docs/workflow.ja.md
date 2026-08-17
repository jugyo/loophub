# Execute / Verify workflow — ポインタ入力と HEAD/review 観測による親子協調

> Status: Implemented · Issue: #975 / #981 / #1284 / #1307 / #1358 / #1555 / #1556 / #1680 / #1697 / #1712 / #1716 / #1744 / #2103
> 関連: [workflow manifest 設計](workflow-manifest.ja.md)
>
> 本書は、特定の skill を必須とせずに開発 workflow を実行するモデルを定義する。step は
> **Execute / Verify の 2 つに固定**し、ユーザーが設定できるのは各 step に与える prompt だけである。
> #1358 で **artifact 契約と入力合成機構を廃止**し、エージェント間の情報交換を次の 2 原則へ統一した。

- **fact はドメイン状態に書く** — 完了・commits・review などの事実は event / git / DB に記録する。
  エージェント間の直接メッセージ（提出物・artifact）は存在しない。
- **instruction は injection で配達する** — agent への入力は起動プロンプト、または保存済みの実行
  target への注入で届ける。**live Execute へのテキスト注入**は `lh workflow deliver`、コスト超過時の
  実 Esc 入力は agent-control port の key input を使う。子の**起動**は
  `lh workflow launch-step`、**観測**は
  `lh workflow step status` のまま。event 到着時の次の action 判断は worker が既存の reconcile logic で行い、
  構造化 workflow instruction を対象 run の parent pane へ直接注入する。親は blocking watcher を持たない。
  子は親の pane・topology を知らない。
- **rework / 継続作業は同じ Execute セッションを優先する**（#1556）— Execute の実行 target があれば
  parent が `lh workflow deliver` で `orchestrator:` を注入し、毎回 fresh Execute を起こさない。
  deliver が session / target を解決できない、または注入に失敗したときだけ `launch-step` で
  fresh 起動する。**Verify は常に
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
| Execute → 親 | ターン完了の宣言（payload なし） | `lh workflow turn done --run <run>` が event を記録（fact）。worker が state と合わせて instruction にする |
| 親 → Verify | input: (issue 参照, base SHA, head SHA) の 3 ポインタ | 起動プロンプト。合成ファイルなし |
| Verify → 世界 | pass / request_changes ＋ findings | head SHA に pin された PR review（fact） |
| 世界 → 親 | turn done、workflow review 登録、GitHub PR feedback の観測 | worker が event 順に観測済み state と action を生成し、parent pane へ注入する |
| Verify ↔ Execute | 直接のやりとりなし | diff と review という domain object 経由 |

```text
[Web / CLI]
  人間が確認済みの issue で workflow を開始
            │
            ▼
  worker ── event + 現在 state → workflow instruction ──▶ workflow agent（親）
    │                                                  構造化 instructions を実行
    │
    ├─ Execute child を起動（input: repo / issue / pr のポインタ）
    │    責務: 計画 → 実装 → テスト/evidence → 振り返り
    │    出力: commits + 通常の PR body / attachment / comment 操作
    │    宣言: `lh workflow turn done --run <run>`（payload なし）
    │
    ├─ turn done ＋ HEAD 前進を観測 → Verify child を fresh 起動
    │    input: (issue 参照, base SHA, head SHA)
    │    出力: head SHA に pin された PR review
    │
    ├─ request_changes review → 生きている Execute pane へ「review <id> に対応せよ」を注入 → fresh Verify
    └─ fresh pass review → run は running のまま次の worker instruction を待つ
         ├─ 追加指示 → 生きている Execute pane へ注入（注入できなければ人間へ渡す）
         ├─ turn done ＋ HEAD 前進 → fresh Verify
         ├─ turn done ＋ HEAD 不変 → pass は fresh のまま待機
         └─ 明示的 stop → run を恒久終了（merge は人間）
```

## 3. アクターと責務

### 3.1 workflow agent（親 = 観測とポインタ配達に徹する orchestrator）

1. worker から parent pane へ注入された workflow instruction の
   `action`（判断済みの次の行動）、`observed`（その判断に使われた state）、`event`（契機になった run event）
   を読む。task completion と event は timing signal であり、完了や verdict そのものではない。
2. `lh workflow launch-step` で Execute / Verify child を起動する（engine が input ポインタを解決）。
   child の session と実行基盤上の target は関連付けて domain state に記録され、
   `lh workflow deliver` が run の最新 Execute session から target を解決する。配送時に live agent の
   一覧を探索しない。
3. **遷移は「turn done event の観測 → `lh workflow step status` で HEAD / review 状態を観測」で決める。**
   宣言はタイミングの合図であり真実を代替しない。宣言があっても HEAD が前進していなければ Verify を
   起動しない。pane 出力・子の自己申告・idle 検知・**注入の成功自体**は遷移判断に使わない。
4. `lh workflow run advance-to-verify | request-rework | await-human | resume` の意図ベース command で
   通常の lifecycle を遷移する。`current_step` はこの lifecycle を表す。一方、
   `active_step` / `active_session_id` は実際に操作中の child を表し、fresh launch の確認時と
   live Execute 注入時に `deliver` が更新する。この更新自体は lifecycle を遷移しない。
   コスト超過後の継続許可時だけは、人間が lifecycle の resume より先に専用の
   `increase-cost-limit --expected-limit <usd>` を実行する。
5. request_changes / 継続指示 / merge conflict は **同じ Execute 注入経路** として
   `lh workflow deliver --run <run> --text '<single-line instruction>'` を使う。コマンドが最新 Execute
   session と登録済み実行 target を解決し、live control target を更新して、改行・制御文字を空白に
   sanitize した指示を agent-control port 経由で送る。rework は
   `orchestrator: address review <id>` のみ（findings の要約・解釈はしない）。deliver が non-zero の
   場合は retry や relaunch を行わず人間へ渡す。run は生きている Execute child を 1 つしか持たず、
   それがある run への `launch-step --step execute` は 409 で失敗する（同じ worktree を 2 つの child が
   編集する二重起動を、成功として記録させないため）。fresh launch の確認は active step/session も
   自動記録する。修正後の Verify は常に fresh child とする。
6. コスト上限超過では event payload の `usage_session_id` と `active_step` /
   `active_session_id` を区別し、run を needs-human hold にしてから active child の pane だけに
   実 Esc と理由通知を送る。ここまでが `cost-hold` の責務で、親はその後 loop に戻る。増額と再開の判断は
   人間が行う。解消不能状態もリンク済み PR の comment + needs-human 状態で人間へ渡す。
7. passing verdict 後も run と parent agent、および可能なら Execute pane を維持し、追加指示や
   turn-done を待つ。run を恒久終了する command は無く、終了させるのは人間である。merge はしない。

親は idle 検知を使わない（`herdr agent wait --status idle` を使わない）。注入前に子の idle を待たない。
rework は通常 Execute の turn done 後に届く。継続指示が作業中に来ても注入する（Esc は
`workflow_run.cost_exceeded` のときだけ）。親はコード・review・PR を直接編集しない。

### 子 pane の配置

run は anchor pane を 1 つだけ持つ。それは parent 起動時に run へ登録された parent agent の pane であり、
instruction の注入先と同一である。child step はこの pane を split して作られ、run の tab は Herdr が
その pane を今どの tab で報告しているかで決まる。launch-step を実行した process の `HERDR_PANE_ID` /
`HERDR_TAB_ID` や、その時点の focus は配置に関与しない（parent pane が未登録の run に限り、呼び出し元の
pane が fallback anchor になる）。

grid 整列は同じ anchor を第 1 セルとして tab を組み直す。したがって anchor は staging tab へ退避される
対象にならず、整列が途中で失敗しても parent pane は元の tab に留まる。残りの pane の並びは Herdr の
pane id ではなく LoopHub が label に書いた child sequence（`executor #<run>-<n>`）で決まる。tab に
別 run の pane・所有者不明の pane・2 つ目の parent pane がある場合は組み直さず可視 error にする。

### Worker instruction delivery

worker は run が所有する 3 つの subject —— run 自身、その issue、その PR —— の event を
`workflow_runs.event_cursor` より後から検出し、`lh workflow next` と同じ reconcile / action-plan logic へ
event と現在 state を渡す。生成結果は `workflow instruction: <JSON>` の
1 行として、run に登録済みの唯一の parent pane に `pane send-text` で注入し、その成功後に
`pane send-keys Enter` で投稿する。本文は bracketed paste で囲んで送るため、閉じ marker 以降の
`Enter` は coding agent の paste 処理に取り込まれない。request を分けること自体は保証にならない
（[根本原因](herdr-prompt-unsent-root-cause.ja.md)）。
repository の `.loophub/workflow.yml` はこの経路に関与しない。

購読の下端は run 自身の `workflow_run.started` event を含む。selector の exclusive bound には
`max(event_cursor, started_event_id - 1)` を渡すため、run 開始より前に記録された issue / PR の event は
選択されず、未消費の started event 自体は初回 Execute instruction として 1 回選択される。cursor の事前の
書き換えは不要である。started event が無い run は cursor 0 へ fallback せず、cursor を進めないまま可視
error になる。event は 1 行ずつ進めるため、間に挟まった無関係な event も失われない。

source event の instruction ownership は payload marker ごとに決まる。marker のない旧 source は state
observation だけを wake し、instruction receipt を作らず cursor を進める。その legacy twin が instruction と
receipt を所有する。marker のある source は自身が instruction と receipt を所有し、後着した legacy twin は
superseded として receipt を作らず cursor だけを進める。

CLI は parent の Herdr 起動成功後に pane 座標を run へ登録し、その pane の agent は起動プロンプトの指示で
`lh workflow parent-ready <run>` を実行して readiness を記録する。pane 登録は pane の存在しか示さず、
起動途中の agent はまだ pane を読んでいないため、この 2 つが揃うまで配送しない。worker は最古の event を
run 作成から 10 分間だけ未処理のまま待つ。猶予後も pane row が無ければ missing-parent receipt、readiness が
無ければ parent-not-ready receipt と worker error を一度残し、自動再試行しない。両方が揃うと event id 順に
判断する。各 event の判断は action、reason、
instructions の fingerprint を receipt に記録し、直前の event と同じ instruction だけを入力せずに処理済みにする。
注入開始前に `workflow.instruction:<fingerprint>` effect receipt を claim し、成功後に complete する。
登録済み pane の座標不備や送信途中の失敗は、自動再実行すると二重入力になり得るため pending receipt と
worker error log を残し、operator 判断に委ねる。注入成功または同一判断の抑止後だけ cursor を進めるため、
worker 再起動後は処理済み event を再配信せず、未処理 event は引き続き対象になる。terminal run の event は
progression instruction を送らず cursor だけ進める。

GitHub reference の event は親の変更要否判断を必要とするため、`read_github_reference`
action を届ける。action は event id と canonical reference だけを含み、untrusted な comment 本文は含まない。
親は `gh api` で参照を読んでから
`lh workflow instruction <run> --repo <repo> --event <event_id> --requires-changes true|false --json` を実行する。
この二段目が必要かどうかは action が示すため、親の prompt にこの規則を持たない。
人間からの直接指示は待たずに `lh workflow instruction <run> --note <text|->` で渡す。

`workflow_run.cost_exceeded` の event は `cost_hold` action を返す。親は `lh workflow cost-hold` を実行して
次の instruction を待つ。hold 中の event 再送に対しても同じ action が返るが、effect が
一度きりであることは action ではなく `cost.hold` receipt が保証する。

Esc、pane 通知、PR comment のような DB transaction 外の side effect は、実行前に durable
receipt を claim し、成功後に complete する。

```sh
lh workflow effect begin --repo "$repo" --run "$run" --event "$event" --effect "$key" --json
lh workflow effect complete --repo "$repo" --run "$run" --event "$event" --effect "$key" --json
```

`begin` が `execute: true` を返した場合だけ effect を実行する。recovery や意図的な再処理で receipt が `pending`
なら、effect 済みか否かを自動判定できないため再実行せず、人間へ曖昧状態を可視化する。pending receipt が
残る場合は人間が recovery の要否を判断する。event 読み取りや待機が失敗した場合も non-zero exit を
可視化し、retry や fallback delivery は行わない。

receipt の粒度は effect が何に対して一度きりかで決まる。汎用の `effect begin/complete` は event 単位
だが、`cost-hold` の `cost.hold` は (run, 累計上限) 単位である。同じ上限に対する
`workflow_run.cost_exceeded` は再送されて複数 event になるのに、要求している中断は 1 回だけだからで
ある。

service test は正しい parent pane の特定、構造化 instruction、cursor の順序どおりの前進、連続する同一判断の
重複防止、起動猶予内の pane 未登録、readiness 未着時の保留、猶予後の pane 欠落と readiness 欠落、登録座標
不備、送信途中 failure、terminal run の扱いを実 DB と fake herdr で確認する。integration test は実 git / DB 状態に対する `workflowRuns.next` の
結果と、pane へ入力された instruction の JSON が同一であることを比較する。

```sh
npm test -- --run core/service/workflow-instructions.test.ts
npm run test:integration -- core/workflow-runs-service.test.ts
```

generated parent prompt の test は blocking watcher を起動せず、worker から届く構造化 instruction を待つ
contract を検証する。

### 注入 round の監査

`deliver` は内部で `activate-step` と同じ live-control target 更新を行うが lifecycle を遷移しない。
注入 round 自体は既存の domain fact だけで追え、監査専用の lh コマンドは追加しない。

- `lh workflow run request-rework` が `rework_count` を増やす。
- Execute の各ターンは `workflow_run.turn_done` event を残す。
- 注入成功時は `step_sessions_json.execute` に既に記録済みの **同一 session** が使われる
  （`launch-step` を呼ばないため execute session id は増えない）。注入失敗後の fresh launch だけが
  新しい execute session id を追加する — これが「同じセッション継続」と「再起動」の差になる。

### 3.2 Execute agent（ドメインを知る pull 型開発者）

1. `lh issue view` / `lh pr view` で issue・PR を読み、rework 時は
   `lh pr review view <pr> --review <id> --json` で対象 review と全 review comments を読む。
2. 関連コードを見て最小の実装計画を session 内に持つ（独立 artifact として提出しない）。
3. 実装し、repo 標準の test / lint / typecheck を green にする。
4. 結果を **ドメイン状態** に書く: commits、`lh pr update` による PR body、`lh attachment add`、
   `lh pr comment`。
5. ターン完了を `lh workflow turn done --run <run>`（payload なし）で宣言する。**commit 前に宣言しても run は
   進まない**（親が HEAD 前進を観測しないため）。

human follow-up が source の修正を要求する場合、Execute は対象を読んだ後、PR comment には編集前に
top-level の `lh pr comment` で対象 `comment <id>`、認識したこと、対応する意思を明記する。diff feedback
には編集前に対象 thread の `lh pr feedback reply` で対象 `comment <id>`、認識したこと、対応する意思を
明記する。review rework は、注入された `review <id>`、その review と `review comment`、対応 commit、
`workflow_run.turn_done` event から対応関係を追跡する。文章での応答が必要なら
`lh pr review-response add <pr> --review <id> [--review-comment <id>] --body <text>` で対象に紐づけ、
top-level の `lh pr comment` は使わない。質問、確認、PR metadata の更新のみなど source の修正を伴わない
follow-up では、編集前の着手返信を必須としない。

`orchestrator:` 注入や launch 時の `--note` で届く **追加作業指示**（rework 以外の human note /
continuing instruction など）は、自然に Issue / PR への追加要望と読めるならそのように扱い、同じ
issue・PR に対して実装する。完了後は通常の Execute と同じく **commit（ドメイン変更がある場合）→
必要なら PR body / comment / attachment の更新 → `lh workflow turn done --run <run>`** に戻る。rework
（`address review <id>`）は review 対応であり追加要望とは別だが、どちらも完了後の経路は同じ。
質問のみ・判断待ちは escalate して同 pane で待機し、確認のみや HEAD を進めない更新（PR body 等）は
commit せず turn done してよい（親は HEAD 不変なら既存 pass を維持し、HEAD 前進時だけ fresh Verify
する）。issue body への追記は必須ではない。

### 3.3 Verify agent（固定ポインタの独立検証者）

launch 時に (issue 参照, base SHA, head SHA) を受け取り、`git diff <base>..<head>` を自分で計算して
その固定 diff だけをレビューする。レビュー範囲をその diff から拡張せず、PR body・実装者の説明は
読まない（PR 番号は review の提出先としてのみ与えられる）。source は編集せず、必要なテストは実行できる。
出力は `lh pr review submit --commit <head sha>` による、head SHA に pin された PR review
（pass / request_changes）のみ。毎回 fresh session で起動される。

### 3.4 非対称性は意図的な設計判断

「Execute = pull・ドメインアクセスあり / Verify = 固定ポインタ・PR メタ非参照」という非対称性は、
検証の独立性を、変更がどう説明・フレーミングされたかから切り離すための意図的な選択である。Verify を
pull 型にして「対称化」することは独立性境界を壊すため明示的に禁止する。

## 4. workflow 定義

workflow は global な prompt bundle として DB に保存する（Execute prompt / Verify prompt の 2 つ）。
この定義は workflow の新しい run を開始するときに読み取られ、run ごとの workflow manifest と
step prompt の sidecar に snapshot される。以後の step 起動はこの snapshot を参照するため、
`lh workflow update` で global な workflow 定義を変更しても、既に開始済みの run の prompt には
反映されない。変更後の prompt は新しく開始する run から有効になる。

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
| Verify | head SHA に pin された PR review | 最新 review が current HEAD に pin されている（fresh） |

`lh workflow step status <run> --json` は観測結果を返す: current HEAD、HEAD が base より先行しているか、
最新 turn-done 宣言の時刻、各 step の状態（Verify は最新 workflow review の id / event / **fresh**）。
これが遷移判断の唯一の根拠である。

### 検証 freshness

freshness は review の pin された head_sha と current HEAD の比較だけで導出する。current HEAD に対する
pass 後、新しい commit で HEAD が進んだ場合は既存 review が stale となり fresh Verify が必要になる。
一方、PR body・comment・attachment だけの更新は HEAD を変えないため、既存 pass は fresh のままである。
Workflow 専用の freshness / dirty / checkpoint 状態は追加しない。

## 6. 完了宣言（turn done）

Execute は `lh workflow turn done --run <run>`（payload なし）でターン完了を宣言する。情報不足や人間の判断が必要な
場合は、質問全文を自分の pane に提示し、`lh workflow escalate --run <run> --reason <short summary>` を宣言して、
同じ pane で人間の回答・指示を待つ。reason は `await-human` と同じ inline text（必須、最大 500 文字）
であり、質問内容の短い要約を入れる。engine はこれらをそれぞれ `workflow_run.turn_done`、
`workflow_run.escalated` event として
記録するが、escalate 自体は run lifecycle を変更しない。review、PR comment、diff feedback、merge
conflict、GitHub feedback、close / merge は、通知専用の run-scoped event を持たない。producer は
`pull_request.review_submitted`、`pull_request.github_feedback`、
`pull_request.diff_feedback_created` / `pull_request.diff_feedback_replied`、`pull_request.commented`、
`pull_request.merge_conflict`、close / merge の source event を 1 件だけ記録し、その PR を所有する run が
購読で選択する。source payload には run が読む stable id と producer の session id、および
`source_payload_version: 1` が載る。自分の parent / child が書いた diff reply や agent の PR comment は、
選択されても instruction にはならない（source の `session_id` と PR comment の `author_type` で判定する）。
親はこの wake で `orchestrator: address diff feedback thread #<t> comment #<c>` を Execute へ配送し、
Execute は `lh pr feedback pending <pr> --run <run>` で未対応の会話と anchor 周辺の diff を読む。
source の修正が必要なら、対象 thread へ認識と対応意思を返信してから編集する。
1 コメントにつき event は 1 件、wake は 1 回なので配送も 1 回である。usage sweep が run の累積コスト上限越えを検知すると `workflow_run.cost_exceeded` が記録される。
累計 cost が現在の累計上限を超えていて run が human hold されていない間は、同じ run・累計上限に対して
再送間隔ごとに最大 1 回まで再送され続ける（既定 5 分、env `LOOPHUB_COST_REEMIT_MS` で調整し、0 は毎
sweep 再送）。生存している親は再送間隔より早く hold を確立するため通常は再送されず、親が wake 後・
`cost-hold` 前に停止した場合だけ後続の wake で interrupt が再び届く。hold が確立するか累計上限が増額
されると再送は止まる。run 開始時には設定された
上限を固定増分 `B` と初期累計上限 `B` の両方として保存するため、その後の設定変更は既存 run に
影響しない。payload には `cost_usd`、`limit_usd`、`increment_usd`、`next_limit_usd` が含まれる。
`usage_session_id` はコスト更新を検知した
usage 集約であり、中断対象ではない。中断対象は別フィールドの `active_step` /
`active_session_id` である。passing Verify 後の追加 Execute 中も `current_step` は Verify のままだが、
直前の `deliver` が行った live-control target 更新により active target は Execute になる。親はその
step の active session に関連付けられた実行 target を解決し、まず run を `await-human` で hold
してから agent-control port で実 Esc を送り、同じ target に
`orchestrator: Cost limit exceeded: current $<cost>, limit $<limit>. Wait for human instruction.`
という 1 行を一度だけ通知する。key input と text input は別の port 操作である。ここまでが
`cost-hold` の効果であり、粒度が event id 単位でないのは、同じ上限に対して event が
再送されるためである。停止中に溜まった event を drain したときの `cost-hold` は `already_completed` を
返し、effect を再発火しない。親は worker instruction の `cost_hold` action を実行したら次の instruction を
待つだけで、続行可否を自分では問わない。event の
filter は payload の `id` を使って対象 run に絞り込む。子の contract に親の pane id や topology は現れない。

継続を許可するのは人間である。人間は `lh workflow step status` で current HEAD / review / step を確認し、
`lh workflow run increase-cost-limit --run <run> --expected-limit <limit_usd>` で累計上限を固定増分 `B`
だけ増やす。この操作は run が human hold 中で、期待上限が DB の現在値と一致し、その上限に対応する
cost exceeded event がある場合だけ原子的に成功する。成功後に限り `resume --step <active_step>` で
hold を解除する。通常の resume 自体は上限を変更しない。resume 後の親は通常の reconcile に戻り、Execute は
同じ pane で続行し、Verify は中断した子を再利用せず current HEAD に対する fresh child を起動する。
増額されなければ hold は維持され、注入・step 遷移・子起動は行われない。`cost-hold` の pane 解決、hold、
Esc、通知のいずれかに失敗した場合は成功扱いせず、親 pane に command と error を表示し、
`lh workflow escalate-human --repo <repo> --run <run> --reason <text>` でリンク済み PR の comment に通知して
hold を維持する。
同じ edge の再処理で暗黙 retry や通知の重複を行わない。

これらの wake はいずれも真実を代替しない timing signal である。親は wake の後に
`lh workflow step status`、PR review、または参照された GitHub API resource から domain state を再観測して
判断する。review の verdict や feedback 本文を通知 payload の複製で判断しない。idle 検知は完了推定に
一切使わない。

## 7. 親の遷移

| From | 観測条件（step status） | Action |
|---|---|---|
| start | run started | worker instruction に従って Execute を launch |
| Execute | HEAD が base より先行し、最新 review より前進 | `advance-to-verify` → Verify を fresh launch |
| Execute | `workflow_run.escalated` を受領 | event の reason で `escalate-human` → 親 agent が担当するリンク済み PR の comment に通知。run state は変えず、人間の指示まで step launch も rework もしない |
| Execute / Verify | `workflow_run.cost_exceeded` を受領 | `cost_hold` action → `cost-hold` が active child を解決 → `await-human` → 実 Esc + 1 行通知（再送分は `already_completed` で effect を発火しない）→ loop に戻る |
| Cost hold | 人間が増額 | 人間が期待上限付き専用操作で `B` 増額 → hold を解除。Execute は同じ target で続行し、既に Verify に到達した run の `current_step` は維持する。Verify は current HEAD に fresh launch |
| Cost hold | 増額なし | hold を維持し、子起動・注入・自動遷移を行わず次の明示的指示を待つ |
| Human wait | Execute の turn done 後、HEAD が最新 review より前進 | `resume --step execute` → 通常の Execute 完了遷移 → fresh Verify |
| Human wait | Execute の turn done 後、HEAD が不変 | hold を維持し、追加作業または明示的 resume を待つ |
| Verify | 最新 review が fresh + pass | run を `running` のまま維持し、次の worker instruction を待つ |
| Verified + continuing | 人間が追加作業を指示 | `run resume` は使わず、`lh workflow deliver` で既存 Execute target へ注入する。deliver が失敗すれば二重起動を避けて人間へ渡す |
| Verified + continuing | Execute の turn done 後、HEAD が passing review より前進 | run は Verify のまま、現在の HEAD に対する Verify を fresh launch |
| Verified + continuing | Execute の turn done 後、HEAD が不変 | 既存 pass は fresh のまま。Verify を起動せず待機を続ける |
| Verify | 最新 review が fresh + request_changes | rework → Execute |

fresh pass は現在の HEAD を検証するが、run を完了・凍結しない。parent agent と Execute target を維持し、
同じ run で追加作業を受け付ける。追加指示時に run は人間待ち hold ではないため `run resume` を使わない。
保存済みの Execute target へ parent が `lh workflow deliver` で `orchestrator: <instruction>` を注入する。
deliver が失敗した場合、生きている Execute child がある run への `launch-step --step execute` は拒否される
ため、error を見える状態のまま人間の判断へ渡す。
その後の turn done で HEAD が進んでいれば fresh Verify を起動し、PR body・comment・attachment だけが
変わって HEAD が不変なら既存 pass を fresh のまま維持する。run を恒久終了する command は無く、
終了させるのは人間である。

rework 上限は 8。rework は parent の **1 行の**
`lh workflow deliver --text 'orchestrator: address review <id>'` による同じ Execute session への注入で行う。
コマンドは DB 上の最新 Execute session と保存済み実行 target を再利用する。`request-rework` は
`current_step` を `execute` に戻すのと同じ更新で `active_step` / `active_session_id` をその Execute child に
向け直す。両者を一度 null にすると、生きている child が居るのに「Execute 未起動」に見える窓ができ、
その窓で worker が reconcile すると二重起動する（#2150）。session / target を解決できない、または注入に
失敗して non-zero になった場合は、二重起動を避けて人間の判断へ渡す。
修正後の Verify は常に fresh child とする。注入の成功自体を execute complete の根拠
にしない — 次の遷移は `lh workflow step status` の HEAD / review 観測のみ。

上限到達後に fresh な request_changes を観測したときは rework せず、`escalate-human` でリンク済み PR の comment に
通知する。この escalation は run を DB で hold しない（`needs_human_reason` は null のまま）ため、復帰は
人間の指示を `lh workflow instruction <run> --note <text>` に渡すことで行い、返る action は既存 Execute target への
`deliver` である。`run resume` を経由しないので rework count は上限のまま残り、以降の request_changes は
毎回 escalation として人間に戻る。`run resume` は cost hold のような `await-human` による明示的 hold を
解除する経路として残る。

宣言がないまま run 活動が停止しても、worker が時間経過だけで run を自動ホールドすることはない。進捗の
有無は turn done と HEAD / review を観測する parent が扱い、本当に死んだ run は人間が気づいて stop /
resume する（人間がリカバリ可能な失敗に自動機構を足さない原則）。rework 上限・escalation・
人間による resume は引き続き機能する。新規に到達し得る run の status は `running` のみ
（人間待ちは `running` のまま needs_human_reason を持つ）。`completed`（#1513）と `stopped`（#1525）は
legacy status で、いずれも書き込み経路は削除済み。古い DB 行として残り得るため UI / serialize は
read-only 表示だけ維持する。

fresh pass 後も run は complete せず `running` + `verification_status: verified` のまま保つ。run を恒久
終了する command は無い。コスト超過時は `cost-hold` が needs-human hold を先に設定し、
agent-control port の key input で active child だけを中断する。人間の判断なしには増額も再開もしない。
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
lh workflow deliver --run <id> --text <single-line-instruction> # 最新 Execute を activate して指示を注入
lh workflow turn done --run <id>          # Execute child がターン完了を宣言（payload なし）
lh workflow escalate --reason <text> --run <id> # Execute child が人間の判断の必要性を宣言
lh workflow escalate-human --reason <text> --run <id> # 親 agent のリンク済み PR への comment を冪等に記録
lh workflow instruction <run> (--event <id> --requires-changes true|false | --note <text|->) --json # 親の入力（GitHub reference の判断 / 人間の直接指示）に対する instruction を返す
lh workflow step input <run> <step>         # 合成した contract + input ポインタ + prompt を dry-run
lh workflow step status <run> --json        # HEAD/base・最新 turn-done・最新 workflow review の freshness を観測
```

`lh workflow step output` は廃止した。Verify の出力は `lh pr review submit --commit <sha>`
を用いる。

### `lh workflow start` の herdr セッション

`lh workflow start`（Web の **Start workflow** が spawn する `--herdr` 経路を含む）で parent を
herdr に起動するとき、対象リポジトリの herdr セッションが未起動なら、まず headless の herdr server
を起動してから workflow を実行する（#50）。セッションが既に起動していればそれを再利用する。herdr
の binary 欠如・タイムアウト・`session list` の失敗など、セッションの状態確認や起動に失敗した場合は
workflow を開始せず明示的なエラーで終了する（失敗を黙って握りつぶさない）。

## 9. 廃止と移行

- `execution-report` / `verdict` の型・validation・placement・placement claim・retry、および PR body /
  review への自動配置処理を active path から取り除いた。`lh workflow step output` は廃止。
- 旧テーブル `workflow_artifacts` / `workflow_placements` / `workflow_step_pins` /
  `workflow_artifact_submitters` は、既存 DB では **履歴としてそのまま残す**（削除・変換しない）。
  新しい run はこれらを一切参照しないため、旧データが新しい run の進行条件になることはない。fresh
  install ではこれらのテーブルを作成しない。一時ロック用の `workflow_placement_claims` のみ DROP する。
- CLI・RPC / wire type・Web UI・run history・本書から artifact 契約前提の API・表示・用語を削除した。
  Workflow 専用の語彙として残るのは **input**（起動時に子へ渡すポインタ群）のみである。
- `lh workflow next` は廃止した。状態変化からの進行判断は worker の instruction 配送が担い、親が
  instruction を取りに行く経路（`--watch` を含む）は無い。親自身の入力—GitHub reference に対する
  変更要否の判断と、人間からの直接指示—だけを `lh workflow instruction` で渡す。

## 10. 実装境界

| 層 | 責務 |
|---|---|
| `core/agent-control.ts` | text input、key input、close を抽象化する agent-control port |
| `core/workflow/contracts/` | parent / Execute / Verify contract |
| `core/workflow/compose.ts` | contract render と「ポインタ + step prompt」の launch prompt 合成 |
| `core/workflow/manifest.ts` | run の動作条件を固定する manifest の型、検証、JSON 化 |
| `core/workflow/run-files.ts` | run ごとの manifest、step prompt、contract ファイルの読み書き |
| `core/workflow/steps.ts` | HEAD / review 観測から 2 step の状態を導く pure query |
| `core/service/workflow-runs.ts` | run start、child launch、turn done、status、rework |
| `core/service/workflow-instructions.ts` | run event から parent pane への構造化 instruction 配送 |
| `core/service/workflow-panes.ts` | run の anchor pane（登録済み parent pane）の解決 |
| `core/terminal/workflow-pane-layout.ts` | anchor pane からの run tab 解決と grid 整列 |
| `core/service/agent-control.ts` | provider に対応する agent-control adapter の選択 |
| `core/service/herdr-agent-control.ts` | agent-control port の Herdr adapter |
| `worker/runner.ts` | workflow instruction 配送と repository automation の event tail |
| `core/store/agent-execution-targets.ts` | agent session と実行 target の関連の persistence |
| `core/store/workflows.ts` | 2 prompt と workflow run / effect receipt の persistence |
| `core/serialize.ts` | workflow / run の wire shape |
| `cli/commands/workflow.ts` | flag 解析と JSON / text 表示だけの thin CLI |
| `web/src/components/workflow-run-status.tsx` | Execute → Verify tracker と最新 review 表示 |

## 11. 検証観点

- 「Execute → turn done → Verify pass → running のまま追加指示を待機」「追加指示 → Execute 注入または
  `--note` 付き launch → HEAD 前進時だけ fresh Verify」「request_changes → rework 注入（review id のみ、
  同じ Execute セッション優先）→ turn done → fresh Verify pass」「target 無し時だけ fresh Execute
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
- worker は turn done、review submitted、GitHub feedback を含む event を event id 順に処理し、連続する
  event の判断が同じ場合だけ重複入力を抑止する。判断は毎回 observed state から決まり、正しい run の
  登録済み parent pane だけへ届く。
- 親 rollout と同じ累積 token counter prefix を引き継ぐ fork 子 2 本を集約しても prefix は 1 回だけ
  加算され、各子は fork 後の増分だけになる。
- `workflow_run.cost_exceeded` は usage 更新元と active step/session を別フィールドで記録し、親は
  fresh launch または注入直前に記録した active target を hold 後に key input で中断し、
  1 行通知を一度だけ送る。
- 上限超過のまま hold されていない run には `workflow_run.cost_exceeded` が再送間隔ごとに再送され、
  親が wake 後・`cost-hold` 前に停止しても後続 wake で hold できる。hold 確立後と増額後は再送されない。
- 停止中に溜まった再送 event を親が順に処理しても、Esc・child 通知・yes / no の継続確認はいずれも一度しか
  発火しない。`cost.hold` の receipt は event id 単位ではなく (run, 累計上限) 単位で、同じ上限に対する
  後続 event は `already_completed` になる。親はこれを skip するため、増額・resume 済みの子を再び中断せず、
  決定済みの質問を人間へ再提示せず、古い `limit_usd` で増額を試みず、pending receipt も残さない。
  増額後の新しい上限を超えた場合は別の上限なので改めて hold し、改めて確認する。
- fresh pass 後の追加 Execute では `current_step: verify` を維持しつつ
  `active_step: execute` / 当該 session を記録し、コスト超過時に verifier ではなく executor を止める。
- コスト続行確認は同じ run・累計上限につき yes / no を一度だけ表示し、yes は step status 再確認後、
  期待する現在上限を指定した専用操作で固定増分 `B` だけ増額してから再開する（Verify は fresh child）。重複操作や古い event、
  通常 hold に対する増額は非0で拒否され、通常 resume は上限を変えない。no は増額も自動進行もせず、
  操作・確認失敗は可視な error として残る。
- idle 検知が遷移・完了判定に使われない。
- 旧 artifact テーブルが新しい run の進行条件にならない。
