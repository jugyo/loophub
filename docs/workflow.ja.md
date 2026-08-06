# Execute / Verify workflow — ポインタ入力と HEAD/review 観測による親子協調

> Status: Implemented · Issue: #975 / #981 / #1284 / #1307 / #1358 / #1555 / #1556 / #1680 / #1697 / #1712 / #1716 / #1744 / #2103
>
> 本書は、特定の skill を必須とせずに開発 workflow を実行するモデルを定義する。step は
> **Execute / Verify の 2 つに固定**し、ユーザーが設定できるのは各 step に与える prompt だけである。
> #1358 で **artifact 契約と入力合成機構を廃止**し、エージェント間の情報交換を次の 2 原則へ統一した。

- **fact はドメイン状態に書く** — 完了・commits・review などの事実は event / git / DB に記録する。
  エージェント間の直接メッセージ（提出物・artifact）は存在しない。
- **instruction は injection で配達する** — agent への入力は起動プロンプト、または保存済みの実行
  target への注入で届ける。**live Execute へのテキスト注入**は `lh workflow deliver`、コスト超過時の
  実 Esc 入力は agent-control port の key input を使う。子の**起動**は
  `lh workflow launch`、**観測**は
  `lh workflow state` である。resource が変わったときは、その購読者へ内容を持たない ping が届き、次の
  action は親が state を読んで決める。親は blocking watcher を持たない。子は親の pane・topology を
  知らない。
- **rework / 継続作業は同じ Execute セッションを優先する**（#1556）— Execute の実行 target があれば
  parent が `lh workflow deliver` で `orchestrator:` を注入し、毎回 fresh Execute を起こさない。
  deliver が session / target を解決できない、または注入に失敗したときだけ `launch` で
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
| Execute → 親 | ターン完了の宣言（payload なし） | `lh workflow turn done` が event を記録（fact）。親はその ping で起き、state を読む |
| 親 → Verify | input: (issue 参照, base SHA, head SHA) の 3 ポインタ | 起動プロンプト。合成ファイルなし |
| Verify → 世界 | pass / request_changes ＋ findings | head SHA に pin された PR review（fact） |
| 世界 → 親 | turn done、workflow review 登録、GitHub PR feedback の観測 | 変化した resource の購読者へ内容を持たない ping が届き、親が `lh workflow state` で現在の事実を読む |
| Verify ↔ Execute | 直接のやりとりなし | diff と review という domain object 経由 |

```text
[Web / CLI]
  人間が確認済みの issue で workflow を開始
            │
            ▼
  ping（subscription + resource の identity）──▶ workflow agent（親）
    │                                             state を読んで次の行動を決める
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
    └─ fresh pass review → run は running のまま次の ping を待つ
         ├─ 追加指示 → 生きている Execute pane へ注入（注入できなければ人間へ渡す）
         ├─ turn done ＋ HEAD 前進 → fresh Verify
         ├─ turn done ＋ HEAD 不変 → pass は fresh のまま待機
         └─ 明示的 stop → run を恒久終了（merge は人間）
```

## 3. アクターと責務

### 3.1 workflow agent（親 = 観測とポインタ配達に徹する orchestrator）

1. 起動直後に `lh events subscribe` で自分の pane と run / issue / PR を購読し、以後は
   `lh workflow state <run> --json` で読んだ現在の事実から次の行動を決める。**行動は state で決め、
   events は経緯を調べるときだけ読む。** pane に届く ping は identity しか運ばず、何が変わったかを
   主張しない。task completion と ping は timing signal であり、完了や verdict そのものではない。
2. `lh workflow launch <run> --step execute|verify` で child を起動する（engine が input ポインタを
   解決）。**起動そのものが `current_step` の記録**でもあるので、phase を進める別の command は無い。
   child の session と実行基盤上の target は関連付けて domain state に記録され、
   `lh workflow deliver` が run の最新 Execute session から target を解決する。配送時に live agent の
   一覧を探索しない。
3. **遷移は「turn done の宣言 → `lh workflow state` で HEAD / review 状態を観測」で決める。**
   宣言はタイミングの合図であり真実を代替しない。宣言があっても HEAD が前進していなければ Verify を
   起動しない。pane 出力・子の自己申告・idle 検知・**注入の成功自体**は遷移判断に使わない。
4. `current_step` は最後に起動した step を表し、`launch` が記録する。読み手は Web の step tracker、
   run history、CLI の表示だけで、次の行動を決める入力ではない。`active_step` / `active_session_id` は
   実際に操作中の child を表し、fresh launch の確認時と live Execute 注入時に `deliver` が更新する。
   この更新自体は phase を遷移しない。request_changes への差し戻しは `lh workflow rework <run>
   --review <id>` の 1 command で、rework の計数・Execute への phase 復帰・固定文の注入までを行う。
   コスト超過後の継続許可は人間が Web UI で増額する操作そのもので、hold の解除は同じ transaction で
   行われる。
5. request_changes / 継続指示 / merge conflict は **同じ Execute 注入経路** として
   `lh workflow deliver --run <run> --text '<single-line instruction>'` を使う。コマンドが最新 Execute
   session と登録済み実行 target を解決し、live control target を更新して、改行・制御文字を空白に
   sanitize した指示を agent-control port 経由で送る。rework は
   `orchestrator: address review <id>` のみ（findings の要約・解釈はしない）。deliver が non-zero の
   場合は retry や relaunch を行わず人間へ渡す。run は生きている Execute child を 1 つしか持たず、
   それがある run への `launch --step execute` は 409 で失敗する（同じ worktree を 2 つの child が
   編集する二重起動を、成功として記録させないため）。fresh launch の確認は active step/session も
   自動記録する。修正後の Verify は常に fresh child とする。
6. コスト上限超過では run 行の `active_step` / `active_session_id` が中断対象であり、run を
   needs-human hold にしてから active child の pane だけに実 Esc と理由通知を送る。ここまでが
   `cost-hold` の責務で、親はその後 loop に戻る。増額と再開の判断は
   人間が行う。解消不能状態も issue comment + needs-human 状態で人間へ渡す。
7. passing verdict 後も run と parent agent、および可能なら Execute pane を維持し、追加指示や
   turn-done を待つ。run を恒久終了する command は無く、終了させるのは人間である。merge はしない。
   state の `pr_closed` / `pr_merged` が true になったら `lh events unsubscribe` で購読を解除して
   loop を終える。

親は idle 検知を使わない（`herdr agent wait --status idle` を使わない）。注入前に子の idle を待たない。
rework は通常 Execute の turn done 後に届く。継続指示が作業中に来ても注入する（Esc は
`workflow_run.cost_exceeded` のときだけ）。親はコード・review・PR を直接編集しない。

### Parent の subscribe / observe / reconcile loop

parent は起動直後に、自分の pane と run が pin する resource —— run 自身、その issue、その PR ——
を購読する。

```sh
lh events subscribe --repo <repo> --target herdr-pane \
  --session "$HERDR_SESSION" --pane "$HERDR_PANE_ID" \
  --resource workflow_run:<run> --resource issue:<issue> --resource pull:<pr> --json
```

この登録は「この pane を読める」の宣言も兼ねる。以前の `lh workflow parent-ready` handshake は
worker 配送のための signal だったので、購読の登録に吸収して廃止した。登録より前に書かれた事実は
最初の observe が拾い、以降の事実は ping が拾うので、`subscribe → observe` の順を守る限り取りこぼす
窓は無い。

以後の loop は observe → reconcile → 次の ping を待つ、の繰り返しである。observe は
`lh workflow state <run> --json` の 1 回の read で、reconcile の順序規則は parent contract に散文で
持ち、コードは持たない。ping が運ぶのは subscription と resource の identity だけで、best-effort である
—— 欠落しても次のどの ping でも state は現在の事実を返し、重複しても state が同じなら parent は何も
しない。`pr_closed` / `pr_merged` を観測したら `lh events unsubscribe` で解除して loop を終える。

CLI は parent の Herdr 起動成功後に pane 座標を run へ登録する。この登録は terminal 表示が live な
parent を解決するためのもので、wake-up 経路ではない —— parent を起こすのは自分で登録した subscription
だけである。repository の `.loophub/workflow.yml` は parent の loop に関与しない。

### 人間の直接指示と GitHub reference

人間の直接指示に command は要らない。parent は自分の pane を読んでいるので、人間はその pane へ直接
書く。parent は次の observe で state と突き合わせ、Execute の作業になるものだけを
`lh workflow deliver` で渡す。

GitHub reference は state の `github_feedback` に content_hash 付きで現れる。parent は前回読んだ hash と
異なる item を `gh api` で読み、untrusted な本文を自分で判断し、Execute の作業が要ると判断したときだけ
1 行を書いて `lh workflow deliver` する。verdict を LoopHub へ submit する二段目は無い。

累計 cost が `cost_limit_usd` に達した run では、parent は `lh workflow cost-hold --run <run>` を実行する。
command は run 単位であり event id を取らない —— 累計上限は run 行の `cost_limit_usd`、累計 cost は
usage、中断対象は run 行の active target から解決する。同じ state を二度読んでも effect が一度きりで
あることは、判断ではなく `cost.hold` receipt が保証する。

Esc、pane 通知、Issue comment のような DB transaction 外の side effect は、実行前に durable
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

integration test は実 git / DB 状態に対する `workflowRuns.state` の観測値を確認する。

```sh
npm run test:integration -- core/workflow-runs-service.test.ts
```

generated parent prompt の test は blocking watcher を起動せず、subscribe → observe → reconcile の
contract を検証する。

### 注入 round の監査

`deliver` は内部で `activate-step` と同じ live-control target 更新を行うが lifecycle を遷移しない。
注入 round 自体は既存の domain fact だけで追え、監査専用の lh コマンドは追加しない。

- `lh workflow rework` が `rework_count` を増やす。
- Execute の各ターンは `workflow_run.turn_done` event を残す。
- 注入成功時は `step_sessions_json.execute` に既に記録済みの **同一 session** が使われる
  （`launch` を呼ばないため execute session id は増えない）。注入失敗後の fresh launch だけが
  新しい execute session id を追加する — これが「同じセッション継続」と「再起動」の差になる。

### 3.2 Execute agent（ドメインを知る pull 型開発者）

1. `lh issue view` / `lh pr view` で issue・PR を読み、rework 時は
   `lh pr review view <pr> --review <id> --json` で対象 review と全 review comments を読む。
2. 関連コードを見て最小の実装計画を session 内に持つ（独立 artifact として提出しない）。
3. 実装し、repo 標準の test / lint / typecheck を green にする。
4. 結果を **ドメイン状態** に書く: commits、`lh pr update` による PR body、`lh attachment add`、
   `lh pr comment`。
5. ターン完了を `lh workflow turn done`（payload なし）で宣言する。**commit 前に宣言しても run は
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
必要なら PR body / comment / attachment の更新 → `lh workflow turn done`** に戻る。rework
（`address review <id>`）は review 対応であり追加要望とは別だが、どちらも完了後の経路は同じ。
質問のみ・判断待ちは escalate して同 pane で待機し、確認のみや HEAD を進めない更新（PR body 等）は
commit せず turn done してよい（親は HEAD 不変なら既存 pass を維持し、HEAD 前進時だけ fresh Verify
する）。issue body への追記は必須ではない。

### 3.3 Verify agent（固定ポインタの独立検証者）

launch 時に (issue 参照, base SHA, head SHA) を受け取り、`git diff <base>..<head>` を自分で計算して
その固定 diff だけをレビューする。レビュー範囲をその diff から拡張せず、PR body・実装者の説明は
読まない（PR 番号は review の提出先としてのみ与えられる）。source は編集せず、必要なテストは実行できる。
出力は `lh pr review --commit <head sha>` による、head SHA に pin された PR review
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

Execute は `lh workflow turn done`（payload なし）でターン完了を宣言する。情報不足や人間の判断が必要な
場合は、質問全文を自分の pane に提示し、`lh workflow escalate --reason <short summary>` を宣言して、
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
ping の対象から外れる（source の `session_id` と PR comment の `author_type` で判定する）。
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
usage 集約であり、中断対象ではない。中断対象は run 行の `active_step` /
`active_session_id` である。passing Verify 後の追加 Execute 中も `current_step` は Verify のままだが、
直前の `deliver` が行った live-control target 更新により active target は Execute になる。
`cost-hold` は run 単位の command であり、event id を取らない —— 累計上限は run 行の `cost_limit_usd`、
累計 cost は usage、中断対象は run 行の active target から解決する。親はその
実行 target を解決し、まず run を `await-human` で hold
してから agent-control port で実 Esc を送り、同じ target に
`orchestrator: Cost limit exceeded: current $<cost>, limit $<limit>. Wait for human instruction.`
という 1 行を一度だけ通知する（usage に unknown cost の session が混ざり累計 cost を確定できない場合は
`current unknown` と表示し、hold 自体は行う）。key input と text input は別の port 操作である。ここまでが
`cost-hold` の効果であり、粒度が event id 単位でないのは、同じ上限に対して event が
再送されるためである。停止中に溜まった event を drain した後の `cost-hold` は、同じ上限なら
`already_completed`、現在の累計上限に対する超過 event が無ければ（増額後に古い上限の event だけが
残っている状態）`not_exceeded` を返し、いずれも effect を再発火しない。親は state から超過を読んで
`cost-hold` を実行したら次の ping を待つだけで、続行可否を自分では問わない。event の
filter は payload の `id` を使って対象 run に絞り込む。子の contract に親の pane id や topology は現れない。

継続を許可するのは人間であり、その操作は Web UI の増額だけである（CLI の口は無い）。増額は run が
human hold 中で、期待上限が DB の現在値と一致し、その上限に対応する cost exceeded event がある場合
だけ原子的に成功する。**増額はその人間の継続判断そのものなので、同じ transaction で hold も解除する** —
`needs_human_reason` を落とし、中断対象が Verify のときは fresh child を起こせるよう active target を
外す（Execute は同じ pane で続行するので保持する）。親は次の観測で通常の reconcile に戻る。
増額されなければ hold は維持され、注入・step 遷移・子起動は行われない。`cost-hold` の pane 解決、hold、
Esc、通知のいずれかに失敗した場合は成功扱いせず、親 pane に command と error を表示し、
`lh workflow escalate-human --repo <repo> --run <run> --reason <text>` で Issue comment に通知して
hold を維持する。
同じ edge の再処理で暗黙 retry や通知の重複を行わない。

これらの wake はいずれも真実を代替しない timing signal である。親は wake の後に
`lh workflow step status`、PR review、または参照された GitHub API resource から domain state を再観測して
判断する。review の verdict や feedback 本文を通知 payload の複製で判断しない。idle 検知は完了推定に
一切使わない。

## 7. 親の遷移

| From | 観測条件（step status） | Action |
|---|---|---|
| start | HEAD も review も無く Execute も起動していない | Execute を launch |
| Execute | HEAD が base より先行し、最新 review より前進 | Verify を fresh launch（起動が phase の記録でもある） |
| Execute | `workflow_run.escalated` を受領 | event の reason で `escalate-human` → Issue comment に通知。run state は変えず、人間の指示まで step launch も rework もしない |
| Execute / Verify | `workflow_run.cost_exceeded` を受領 | `cost_hold` action → `cost-hold` が run 行から上限と active child を解決 → `await-human` → 実 Esc + 1 行通知（再送分は `already_completed` で effect を発火しない）→ loop に戻る |
| Cost hold | 人間が増額 | 人間が Web UI の期待上限付き操作で `B` 増額 → 同じ transaction で hold も解除。Execute は同じ target で続行、Verify は current HEAD に fresh launch |
| Cost hold | 増額なし | hold を維持し、子起動・注入・自動遷移を行わず次の明示的指示を待つ |
| Human wait | 人間が増額して hold が解除された | 通常の Execute 完了遷移 → fresh Verify |
| Human wait | 増額がまだ無い | hold を維持し、子起動・注入・自動遷移を行わず待つ |
| Verify | 最新 review が fresh + pass | run を `running` のまま維持し、次の ping を待つ |
| Verified + continuing | 人間が追加作業を指示 | `lh workflow deliver` で既存 Execute target へ注入する。deliver が失敗すれば二重起動を避けて人間へ渡す |
| Verified + continuing | Execute の turn done 後、HEAD が passing review より前進 | run は Verify のまま、現在の HEAD に対する Verify を fresh launch |
| Verified + continuing | Execute の turn done 後、HEAD が不変 | 既存 pass は fresh のまま。Verify を起動せず待機を続ける |
| Verify | 最新 review が fresh + request_changes | rework → Execute |

fresh pass は現在の HEAD を検証するが、run を完了・凍結しない。parent agent と Execute target を維持し、
同じ run で追加作業を受け付ける。保存済みの Execute target へ parent が `lh workflow deliver` で
`orchestrator: <instruction>` を注入する。
deliver が失敗した場合、生きている Execute child がある run への `launch --step execute` は拒否される
ため、error を見える状態のまま人間の判断へ渡す。
その後の turn done で HEAD が進んでいれば fresh Verify を起動し、PR body・comment・attachment だけが
変わって HEAD が不変なら既存 pass を fresh のまま維持する。run を恒久終了する command は無く、
終了させるのは人間である。

rework 上限は 8。rework は `lh workflow rework <run> --review <id>` の 1 command で行う。この command が
rework を数え、`current_step` を `execute` に戻すのと同じ更新で `active_step` / `active_session_id` を
その Execute child に向け直し、固定文 `orchestrator: address review <id>` を同じ Execute session へ
注入する（DB 上の最新 Execute session と保存済み実行 target を再利用する）。注入文が固定なので、
findings の要約・解釈が入る余地は呼び手に無い。active target を一度 null にすると、生きている child が
居るのに「Execute 未起動」に見える窓ができ、その窓で parent が reconcile すると二重起動する（#2150）。
上限に達した run への rework は core が拒否する。session / target を解決できない、または注入に
失敗して non-zero になった場合は、二重起動を避けて人間の判断へ渡す。
修正後の Verify は常に fresh child とする。注入の成功自体を execute complete の根拠
にしない — 次の遷移は `lh workflow state` の HEAD / review 観測のみ。

上限到達後に fresh な request_changes を観測したときは rework せず、`escalate-human` で Issue comment に
通知する。この escalation は run を DB で hold しない（`needs_human_reason` は null のまま）ため、復帰は
人間が parent の pane に指示を書き、parent が既存 Execute target へ `deliver` することで行う。
rework count を戻す経路は無いので上限のまま残り、以降の request_changes は毎回 escalation として
人間に戻る。`await-human` による明示的 hold（cost hold）を解除するのは Web UI の増額だけである。

宣言がないまま run 活動が停止しても、時間経過だけで run を自動ホールドする機構は無い。進捗の
有無は turn done と HEAD / review を観測する parent が扱い、本当に死んだ run は人間が気づいて対処する
（人間がリカバリ可能な失敗に自動機構を足さない原則）。rework 上限・escalation・人間による増額は
引き続き機能する。run の status は作成時の `running` から動かない
（人間待ちも `running` のまま needs_human_reason を持つ）。run が終わったかどうかは
**linked PR が closed または merged かどうか**であり、その事実は PR 行にある。同じ問いに 2 つの答えを
持たないため、terminal status を書く経路は無く、`completed`（#1513）/ `stopped`（#1525）/ `blocked` は
古い DB 行だけが持つ legacy status である（event の履歴表示だけが read-only で扱う）。「linked PR が
open かつ未 merge」は `openUnmergedPullSql()` として 1 箇所に置かれ、delete guard・GitHub feedback
sweep・lifecycle guard・コスト検出が共有する。

fresh pass 後も run は complete せず `running` + `verification_status: verified` のまま保つ。run を恒久
終了する command は無い。コスト超過時は `cost-hold` が needs-human hold を先に設定し、
agent-control port の key input で active child だけを中断する。人間の判断なしには増額も解除もしない。
hold の解除は Web UI の増額と同じ transaction で行われ、fresh pass 後の追加作業はそもそも hold では
ないので `deliver` だけで足りる。

## 8. CLI

```sh
lh workflow create <name> [--execute-prompt <text>] [--verify-prompt <text>]
lh workflow update <name> [--step execute|verify --file <path|->]
lh workflow start <issue> --workflow <name>
# 親の loop
lh events subscribe --target herdr-pane --session <name> --pane <id> --resource <kind>:<key>... # 起動直後に 1 回
lh events unsubscribe --subscription <id>   # PR が closed / merged になったら
lh workflow state <run> --json              # run の現在の事実を 1 回の read で返す
lh workflow launch <run> --step execute|verify [--review <id>] [--note <text|->] # 起動が phase の記録でもある
lh workflow rework <run> --review <id>      # rework を数え、Execute へ戻し、固定文を注入する
lh workflow deliver --run <id> --text <single-line-instruction> # 最新 Execute を activate して指示を注入
lh workflow turn done [--run <id>]          # Execute child がターン完了を宣言（payload なし）
lh workflow escalate --reason <text> [--run <id>] # Execute child が人間の判断の必要性を宣言
lh workflow escalate-human --reason <text> [--run <id>] [--issue <n>] # Issue comment を冪等に記録
lh workflow step input <run> <step>         # 合成した contract + input ポインタ + prompt を dry-run
lh workflow step status <run> --json        # lh workflow state と同じ観測。呼び手の移行中だけ残す
```

`lh workflow step output` は廃止した。Verify の出力は `lh pr review --commit <sha>`
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
- `lh workflow next` は廃止した。親が判断を取りに行く経路（`--watch` を含む）は無い。進行判断は親が
  `lh workflow state` で読んだ現在の事実から行う。
- `lh workflow parent-ready` は廃止した。「この pane を読める」の宣言は `lh events subscribe` による購読の
  登録が兼ねる。
- `lh workflow instruction` と worker の instruction 配送・action 生成は廃止した。人間の直接指示は parent
  の pane への入力、GitHub reference の判断は `gh api` と `lh workflow deliver` の一段になる。
  `workflow_runs.event_cursor` と `workflow.instruction:*` receipt は履歴として残るだけで、読む側は無い。
  この経路で動いていた旧 run は進まなくなる。新 protocol へは移行させず、人間が PR を閉じて作り直す。

## 10. 実装境界

| 層 | 責務 |
|---|---|
| `core/agent-control.ts` | text input、key input、close を抽象化する agent-control port |
| `core/workflow/contracts/` | parent / Execute / Verify contract |
| `core/workflow/compose.ts` | contract render と「ポインタ + step prompt」の launch prompt 合成 |
| `core/workflow/steps.ts` | HEAD / review 観測から 2 step の状態を導く pure query |
| `core/service/workflow-runs.ts` | run start、child launch、turn done、state、rework |
| `core/service/agent-control.ts` | provider に対応する agent-control adapter の選択 |
| `core/service/herdr-agent-control.ts` | agent-control port の Herdr adapter |
| `core/store/event-subscriptions.ts` | parent の購読と、ping の宛先解決の persistence |
| `core/event-ping-delivery.ts` | 購読者への ping 配送 |
| `worker/runner.ts` | external sync、repository automation、maintenance の event tail |
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
- state は HEAD / base / 最新 review の freshness を返し、head advance で pass が stale になる。
- PR body・comment・attachment だけの更新では pass が fresh のまま維持される。
- turn done、review submitted、GitHub feedback を含む event は、購読している parent の pane へ ping を
  届ける。ping は内容を持たないため、判断は毎回 parent が読み直した state から決まる。
- 親 rollout と同じ累積 token counter prefix を引き継ぐ fork 子 2 本を集約しても prefix は 1 回だけ
  加算され、各子は fork 後の増分だけになる。
- `workflow_run.cost_exceeded` は usage 更新元と active step/session を別フィールドで記録し、親は
  fresh launch または注入直前に記録した active target を hold 後に key input で中断し、
  1 行通知を一度だけ送る。
- 上限超過のまま hold されていない run には `workflow_run.cost_exceeded` が再送間隔ごとに再送され、
  親が wake 後・`cost-hold` 前に停止しても後続 wake で hold できる。hold 確立後と増額後は再送されない。
- 停止中に溜まった再送 event を親が順に処理しても、Esc・child 通知・yes / no の継続確認はいずれも一度しか
  発火しない。`cost.hold` の receipt は event id 単位ではなく (run, 累計上限) 単位で、同じ上限に対する
  後続の `cost-hold` は `already_completed` になる。親はこれを skip するため、増額・resume 済みの子を再び中断せず、
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
