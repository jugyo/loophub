# skill 非依存の Plan/Execute/Verify/Reflect 固定 workflow — 設計メモ

> Status: Design（実装は別 issue） · Issue: #975 · PR: #976 · 改訂: #981（artifact 受け渡しモデル）
> 本書は、skill（`SKILL.md` / slash command）を一切使わずに開発 workflow を実行するモデルを
> 定義する。step は **Plan / Execute / Verify / Reflect の 4 つに固定**し、ユーザーが設定できる
> のは各 step で agent に与える prompt だけである。この 4 step 構成の workflow に名前をつけて
> 複数作成できる。以下この仕組みを **workflow** と呼ぶ。
> 関連: #964 の workflow instruction 管理モデル（`docs/workflow-instruction-model.ja.md`、
> PR #966。本書執筆時点で未マージ）。本書はその skill 非依存版の実験であり、関係は §11 で
> 明文化する。実装（親 agent、UI、RPC、DB migration）はすべて本書のスコープ外。

---

## 1. 目的と非目的

現行の開発 loop（`lh build` → lh-build → lh-pr-review → lh-merge-ready）は、手順のすべてが
skill 本文（`skills/lh-*/SKILL.md`）に埋まっている。手順を変えるには skill を書き換えて
`npx skills add` で配布し直す必要があり、LoopHub は「入口の slash command 文字列」しか
関与できない。

本設計は逆のアプローチを実験する: **手順の骨格（step 構成と各 step の入出力契約）を LoopHub が
所有し、ユーザーは契約の中でどう働くかだけを prompt で設定する。**

#981 の改訂で、この骨格を **artifact の受け渡しで処理が進むモデル**として定義し直した:

```text
step = f(入力 artifact, worktree) → (出力 artifact, commits)
```

子（step agent）はドメイン（issue / PR / review）に触れない。ドメイン状態から入力 artifact を
合成して子に渡し、提出された出力 artifact を schema 検証してドメインへ配置するのは
エンジン（LoopHub）の仕事である（§6）。これは内部の実行アーキテクチャ（小さいエンジン）の
改訂であり、ユーザーに見える設定面は増えない（設定は引き続き step prompt のみ）。

この設計で決めること:

- 親（workflow agent）の責務 — 起動方法、子エージェントの split pane 起動、step 遷移の判断、
  子への追加指示（つつき方）。
- Plan / Execute / Verify / Reflect 各 step の入力・出力の契約（受け取るもの、完了時に残す
  成果物とその形式、完了条件）。
- step の入出力を artifact として定義する（#981）: 4 つの artifact 型と schema、
  `lh workflow step output` による提出と検証、placement policy（検証済み artifact の
  ドメインへの配置）、入力 artifact の launch 時合成。
- step 契約を LoopHub が system prompt として必ず挿入する機構 — ユーザー設定 prompt との
  合成方法、ユーザーが上書き・省略できない境界。
- ユーザーが設定する step prompt の保存場所・形式・編集方法（skill / SKILL.md には置かない）。
- 親が LoopHub から取得する情報と、それに基づく step 遷移・差し戻しの判断基準。
- 名前をつけた workflow を複数作成・保存・選択できるモデル。
- Build ボタン横の Start workflow ボタンから起動する UI と、その起動経路（RPC / CLI）。
- 入口から子エージェントまで skill / slash command に依存しないことの設計上の確認。
- #964 の workflow instruction 管理モデルとの関係。

この設計で決めないこと:

- 実装（親 agent、UI、RPC、DB migration のいずれも）。
- 既存 skill chain（`lh build` → lh-build → lh-pr-review → lh-merge-ready）の廃止・変更。
  workflow は **並ぶもう 1 つの入口**であり、置換ではない。
- workflow のバージョニング（初期バージョンでは不要）。
- Plan / Execute / Verify / Reflect 以外の step 構成のカスタマイズ（汎用 workflow 定義機構は
  作らない）。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| workflow | Plan / Execute / Verify / Reflect の 4 step 固定の開発 workflow。名前を持ち、複数作成できる。ユーザーが設定するのは各 step の prompt だけ。 |
| step | Plan / Execute / Verify / Reflect のいずれか。順序・構成は固定で変更できない。 |
| エンジン | 入力合成・schema 検証・placement・完了判定 query を担う LoopHub 本体のコード（`lh workflow` コマンド群と core、§6.1）。agent ではない。親・子と並ぶ第 3 のアクター。 |
| artifact | step の入出力データの総称。**出力 artifact** は 4 型（plan / execution-report / verdict / reflection）に固定され、提出時に schema 検証される JSON（§6.2）。**入力 artifact** は launch 時にドメイン状態から合成される自由形式のファイル（`task.md` 等。型・schema を持たない、§7.3）。子は入力 artifact を受け取り、出力 artifact を提出する — ドメイン（issue / PR / review）には触れない。データモデルとしても artifact はドメインと結びつかない（配置先もドメイン識別子も持たない正本、§5.2）— PR への紐づけは run の責務（§6.4）。 |
| placement policy | 検証済みの出力 artifact を LoopHub がドメインへ配置する対応（artifact 型 → PR body section / review / comment）。core の単一箇所に集約する（§6.4）。 |
| run directory | `$LOOPHUB_HOME/runs/workflow/<run-id>/` 配下。契約ファイルと入力 artifact のファイル受け渡しに使う。 |
| ambient run context | launcher が子プロセスに環境変数（`LOOPHUB_WORKFLOW_RUN` / `LOOPHUB_WORKFLOW_STEP`）で注入する run / step の識別子。`lh workflow step output` が引数なしで動く根拠（§6.3）。 |
| step contract（契約） | step ごとに LoopHub が定義する入出力の取り決め — その step が入力として何を受け取り、どの型の出力 artifact を提出すれば完了か、何をしてはならないか。LoopHub 同梱（git 管理）で、ユーザーは変更できない。repo / issue 非依存の汎用文書（§6.6）。 |
| step prompt | ユーザーが workflow ごと・step ごとに設定する自由記述 prompt。「契約の中でどう働くか」を指定する。空でもよい（契約だけで step は成立する）。 |
| workflow agent（親） | run ごとに 1 つ起動される orchestrator agent。子を起動し、LoopHub の状態を見て step を遷移させる。コードは書かない。 |
| step agent（子） | 各 step を実行する agent。親が herdr の split pane で起動する。 |
| run | ある issue に対する workflow の 1 回の実行。issue・PR・worktree・親 session に紐づく。 |
| herdr | LoopHub 外部の端末 workspace マネージャ（AI coding agent 向け）。workspace / tab / split pane で agent プロセスを起動・監視でき、pane への入力注入もできる。LoopHub は既に build 等の agent 起動で利用している（§3.1）。 |
| 契約 channel | 契約が agent に届く経路（claude CLI の `--append-system-prompt-file`）。step prompt が届く経路（positional の user prompt）と分離されている。 |

---

## 3. 現状の事実（設計の土台）

設計の前提になる既存機構と、確認済みの技術事実。

### 3.1 LoopHub の起動経路

- Web の Build ボタン（`web/src/components/issue-detail.tsx` の `BuildControls`）は JSON-RPC
  `terminal/launch`（`web/server/contract.ts`）を呼び、`core/service/terminal.ts` の
  `launchIssueDevHerdr` が `lh build <owner>/<repo>/<n> --herdr` を spawn する。
- `lh build`（`cli/commands/build.ts`）は draft PR の作成（`core/service/dev.ts` の `openPr`、
  冪等）、worktree の provision（`core/worktree-provision.ts`、PR 番号 keyed）、dev lock、
  session 登録を行ったうえで、prompt として slash command 文字列 `/lh-build <n>` を positional
  引数で渡して claude / codex を起動する。
- herdr 連携の argv 合成は `core/terminal/terminal-launch.ts` に集約されている
  （`buildHerdrLaunchPlan`、`acquireHerdrWorktreeTab`、`herdrPaneSendKeysArgv` 等）。
- scheduled task は prompt 本文を DB（`scheduled_tasks.prompt`）に保存し、非対話
  （`claude -p` / `codex exec`）で herdr pane 内に起動する — **inline prompt を DB に保存して
  agent に渡す前例**が既にある。

### 3.2 確認済みの技術前提

- **claude CLI** は `--system-prompt` / `--append-system-prompt` / `--append-system-prompt-file`
  を持つ。契約を system prompt として挿入する channel はここを使う。
- **codex CLI**（`codex exec`）には system prompt を追加する公式 flag がない（instructions は
  positional / stdin のみ）。→ v1 の workflow は **claude runtime のみ**対応（§14）。
- **herdr** は次を提供する:
  - `herdr agent start <name> --cwd PATH [--tab ID] [--split right|down] -- <argv...>` —
    既存 tab 内への **split pane での agent 起動**。
  - `herdr agent wait <target> --status <idle|working|blocked|unknown> [--timeout MS]` —
    子の稼働状態の待機（停滞検知に使う）。
  - `herdr pane run <pane_id> <command>` — pane への command text + Enter の注入（つつき）。
  - `herdr agent read <target>` — pane 出力の読取（デバッグ・停滞診断の補助）。
- **親・エンジンが利用できる LoopHub 側の情報**（#981 改訂後、親の遷移判断そのものは
  `lh workflow step status` の query で行う — §8.2）: `lh pr view --json` は `draft` / `head` /
  `review_state` / `comments` / `mergeable` / `changes_addressed_at` を返す。`lh issue view
  --json` は body / comments を返す。`lh events --since <id> --order asc --repo <r> --json` で
  bounded snapshot を cursor polling できる。`lh handoff record / list` で親子間の受け渡しを
  PR に紐づけて記録できる。

---

## 4. 全体像

```text
[Web] issue detail: [Build] [Start workflow ▾]      [CLI] lh workflow start <n> --workflow <name>
            │ terminal/launch (RPC)                          │
            ▼                                                ▼
   lh workflow start（run 開始）
     1. workflow を名前で解決（DB）
     2. draft PR を開く（dev.openPr 再利用・冪等）＋ worktree provision ＋ dev lock
     3. run row を作成（status: running, current_step: plan）
     4. 親を herdr pane で起動（契約 = 親契約、prompt = run context。slash command なし）
            │
            ▼
   workflow agent（親） … 遷移判断は step status（配置済み artifact の query）のみで行う
     │  各 step で:
     ├─ lh workflow launch-step --run <id> --step <step>
     │     エンジンがドメイン状態（issue / PR / review）から入力 artifact を合成 → 子 pane（split）
     │        │
     │        ▼
     │  step agent（子） … 世界 = 入力 artifact + worktree + `lh workflow step output`
     │     Plan: 実装計画 / Execute: commits + 実行報告 / Verify: 判定 / Reflect: 振り返り
     │     lh workflow step output で出力 artifact を提出
     │        │
     │        ▼
     │  エンジン: schema 検証（不正は 422 → 子が修正・再提出）
     │     検証済み artifact を placement policy でドメインへ配置:
     │       plan → PR body（実装計画 section）
     │       execution-report → PR body（Summary/AC/Test plan/Evidence）+ draft→ready
     │       verdict → PR review（pass / request_changes）
     │       reflection → PR comment
     │
     ├─ 親: step status で配置を観測 → 次 step へ
     ├─ verdict が request_changes → Execute へ差し戻し（つつき or 再起動）→ 再 Verify（上限あり）
     └─ run 完了（merge はしない — 人間が行う）
```

子の**起動タイミングの判断は親**が行い、**入力の合成・出力の検証と配置は LoopHub**（`lh workflow
launch-step` / `lh workflow step output`）が行う。この分担が「契約はユーザー prompt でも親の
裁量でも壊せない」（§7）と「子はドメインを知らない」（§6）を支える。

---

## 5. workflow の定義・保存・編集

### 5.1 保存場所と形式

workflow は **LoopHub DB に保存する**。git にも skill にも置かない。

```sql
CREATE TABLE workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,   -- trim 済み・非空・64 文字以内
  description     TEXT NOT NULL DEFAULT '',
  plan_prompt     TEXT NOT NULL DEFAULT '',
  execute_prompt  TEXT NOT NULL DEFAULT '',
  verify_prompt   TEXT NOT NULL DEFAULT '',
  reflect_prompt  TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

- step prompt は **plain markdown text**。frontmatter・slash command・特別な構文を持たない。
  空文字は「その step は契約どおり素で動く」を意味する（有効な設定）。
- DB 保存を選ぶ理由: (1) skill 非依存が本 issue の要件であり、git + `npx skills add` の配布
  レイヤーを踏まない。(2) UI から即座に編集でき、diff を汚さない。(3) scheduled task の
  inline prompt（`scheduled_tasks.prompt`）という同型の前例が既にある。#964 は「instruction
  本文は git、DB は binding だけ」を原則にしたが、その例外として inline prompt（`@task-prompt`）
  を既に認めており、Workflow の step prompt は**この inline 例外の第 2 のケース**である（§11）。
- スコープは v1 では **global**（repo をまたいで共有）。repo ごとの既定 workflow の指定などは
  必要になってから後続 issue で設計する。
- バージョニングはしない。update は上書き。run 実行中に workflow を編集した場合、合成は
  `launch-step` 時点の DB 値で行われるため、**次に起動される step から**反映される（§14）。

### 5.2 run の追跡

```sql
CREATE TABLE workflow_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id        INTEGER NOT NULL REFERENCES workflows(id),
  repo_id            INTEGER NOT NULL,
  issue_number       INTEGER NOT NULL,
  pr_number          INTEGER NOT NULL,
  status             TEXT NOT NULL,   -- running | blocked | completed | stopped
  current_step       TEXT NOT NULL,   -- plan | execute | verify | reflect
  rework_count       INTEGER NOT NULL DEFAULT 0,
  parent_session_id  TEXT,
  step_sessions_json TEXT NOT NULL DEFAULT '{}',  -- step -> [session id]
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
```

提出された出力 artifact は追記型のテーブルに記録する（§6.3）。**artifact は run と worktree の
SHA だけを参照する、ドメイン（issue / PR）非依存の正本**であり、配置先の情報を持たない:

```sql
CREATE TABLE workflow_artifacts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES workflow_runs(id),
  step          TEXT NOT NULL,      -- plan | execute | verify | reflect
  type          TEXT NOT NULL,      -- plan | execution-report | verdict | reflection
  content_json  TEXT NOT NULL,      -- 検証済み artifact 本体
  head_sha      TEXT NOT NULL,      -- エンジンが刻印する SHA（通常は提出時の worktree head、verdict は pin した検証対象 — §6.1。完了判定の pin）
  created_at    TEXT NOT NULL
);
```

artifact を PR へ**紐づけて管理する責務は run 側**にある。配置（§6.4）の記録は artifact 本体
ではなく、run のドメイン紐づけ管理の台帳として別テーブルに持つ:

```sql
CREATE TABLE workflow_placements (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  artifact_id  INTEGER NOT NULL REFERENCES workflow_artifacts(id),
  target_kind  TEXT NOT NULL,      -- pr-body-plan | pr-body-report | review | comment
  target_ref   TEXT NOT NULL,      -- 配置先の参照（review id / comment id / "pr-body"）
  placed_at    TEXT NOT NULL
);
```

run row は UI 表示（この issue はいまどの step か）と、親の状態報告（`lh workflow run update`）
の置き場である。**遷移の真実は配置済み artifact（`workflow_artifacts` × `workflow_placements`）と
現 head の対応**（§6.5）であり、run row はその写しにすぎない — 親が死んで run row が古くなって
も、配置記録と PR の状態から人間が判断できる。

### 5.3 編集方法

| 経路 | 内容 |
|---|---|
| Web UI | Settings に「Workflows」ページを追加。一覧 + 編集フォーム（name / description / 4 step の textarea）。保存時 validation（name 非空・unique）は `422` + form error。 |
| JSON-RPC | `workflows/list` / `get` / `create` / `update` / `delete`。wire shape は `core/serialize.ts` に置き、`web/src/api/types.ts` は型を再宣言しない（既存規約どおり）。 |
| CLI | `lh workflow list` / `view <name>` / `create <name>` / `update <name> [--step plan --file <path|->]` / `delete <name>`。 |

新規作成フォームは、core 定数として持つ**例文 prompt** を prefill する（DB に seed row は
作らない）。実行中の run から参照されている workflow の delete は拒否する。

---

## 6. artifact モデルと step 契約

### 6.1 モデル

step の実行を次の関数として定義する:

```text
step = f(入力 artifact, worktree) → (出力 artifact, commits)
```

子（step agent）の世界は「**渡された入力 artifact + worktree + `lh workflow step output` での
提出**」だけである。子は issue id / PR id / 出力先を知らない — それらはエンジン（LoopHub）の
都合であり、契約にも入力にも現れない（§6.6）。

エンジンの仕事:

1. **入力合成** — ドメイン状態（issue / PR / review）から入力 artifact を合成して子に渡す（§7.3）。
2. **検証** — `lh workflow step output` で提出された出力 artifact を schema 検証し、正本として
   記録する（不正は 422、§6.3）。
3. **配置** — 検証済み artifact を、run が紐づくドメイン（v1 では常に PR）へ placement policy に
   従って投影する（§6.4）。artifact 自体は配置先を知らない — **ドメインへの紐づけの管理は run の
   責務**である（§5.2 の `workflow_placements`）。
4. **完了判定** — 「現 head に対して配置済みの artifact がある」を query として評価する（§6.5）。

worktree は artifact 語彙に次のように統合する: **コンテンツは worktree、参照は SHA**。

- commits は Execute の第 2 の出力であり、artifact には含めない。artifact が worktree の内容に
  言及するときは path（と必要なら行）で指し、版の特定は SHA で行う。
- 提出された artifact には、エンジンが SHA を刻印する（`workflow_artifacts.head_sha`、§6.3）。
  刻印する SHA は artifact 型で決まる: 通常は**提出時の worktree head**、**verdict は例外で
  launch 時に pin した検証対象の SHA**（§7.3 — verdict が語れるのは検証した版だけであり、
  提出時 head を刻印すると「検証中に head が動いたのに現 head と一致する」誤判定が生じる）。
  子は SHA を自己申告しない。
- 入力側も同じ: Verify に渡す diff は launch 時点の head SHA に pin して合成する（§7.3）。
- head 依存の artifact（execution-report / verdict）の完了判定は「配置済み artifact の刻印 SHA
  == 現 head」で行う（§6.5）。head が進めば古い artifact は自動的に stale になる — 「review
  時点より新しい head」のような比較ヒューリスティックは不要になる。

### 6.2 artifact 型と schema

出力 artifact の型は **4 つの列挙で固定**する。ユーザー定義の artifact 型・step 追加・DAG は
作らない（§14）。schema は `core/workflow/artifacts.ts`（pure、後続実装）に置き、提出時に検証する。
以下は wire shape（JSON）。文字列 field は特記なければ非空必須。

**plan**（Plan の出力）

```jsonc
{
  "type": "plan",
  "summary": "何をどう変えるかの要約（markdown）",
  "changes": [ { "area": "変更するファイル / 領域", "description": "何をするか" } ],  // 1 件以上
  "reuse": [ "再利用する既存 API / component / module" ],                             // 0 件可
  "out_of_scope": [ "やらないこと・スコープ境界" ],                                    // 0 件可
  "verification": "どう検証するか（テスト・確認方法）"
}
```

**execution-report**（Execute の出力）

```jsonc
{
  "type": "execution-report",
  "summary": "変更内容の要約（markdown、1–3 bullets 相当）",
  "acceptance": [ { "criterion": "受け入れ基準の項目（入力 task の AC を写す）",
                    "met": true, "note": "未達・スコープ外のときは一行の理由" } ],    // 1 件以上
  "tests": [ { "command": "npm test", "passed": true, "excerpt": "42 pass, 0 fail" } ], // 1 件以上
  "evidence": [ { "kind": "test | cli | screenshot | na",
                  "description": "何を示すか",
                  "path": "screenshot 等のファイル path（kind により任意）" } ]        // 1 件以上
}
```

**verdict**（Verify の出力）

```jsonc
{
  "type": "verdict",
  "event": "pass",              // "pass" | "request_changes"
  "summary": "判定理由の要約",
  "findings": [ { "file": "path", "line": 12,          // line は任意
                  "problem": "何が問題か", "expected": "期待する状態" } ]
  // event == "request_changes" のとき findings は 1 件以上。pass のときは 0 件可
}
```

**reflection**（Reflect の出力）

```jsonc
{
  "type": "reflection",
  "went_well": [ "うまくいったこと" ],
  "friction": [ { "what": "詰まったこと・差し戻し", "cause": "原因" } ],       // 0 件可
  "suggestions": [ { "target": "step-prompt | contract | engine", "text": "改善提案" } ], // 0 件可
  "followups": [ { "title": "後続 issue 候補", "rationale": "理由" } ]         // 0 件可
}
```

文字列 field の値は markdown として扱い、配置時にレンダリングする（§6.4）。artifact は
**ドメインの識別子を含まない** — issue / PR 番号の field は存在しない。どこへ置くかは
placement policy の仕事である。

### 6.3 提出と検証 — `lh workflow step output`

出力 artifact の提出はすべて `lh workflow step output` で行う（CLI としての定義は §9.4）:

- 子は**引数なし**で呼べる: `lh workflow step output --file report.json`（または stdin）。
  run / step の識別は launcher が環境変数で注入する ambient run context
  （`LOOPHUB_WORKFLOW_RUN` / `LOOPHUB_WORKFLOW_STEP`）から取る。子が run id を知る必要はない
  （env の値は提出先を特定する opaque な識別子であり、契約も prompt もその利用を求めない）。
- **検証は配置の前**: (1) run が `running` である、(2) 本文が JSON として parse できる、
  (3) `type` が提出先 step（ambient context または明示指定、§9.4）の期待型と一致、(4) §6.2 の
  schema を満たす。失敗は **422 相当** — 非ゼロ exit + 違反項目の列挙で、**何も記録・配置
  しない**。子はエラーを読んで修正し、再提出する。run row の `current_step` との一致は検査
  **しない** — `current_step` は表示用の写しであり検証の根拠にしない（§5.2 の単一真実の原則。
  これにより親が `run update` を呼ばないエージェントなし運用（§9.4）でも提出できる）。順序の
  整合は完了判定 query（§6.5）が担う。
- **追記 + 最新有効**: 同じ step への再提出は前の提出を置き換える（`workflow_artifacts` に追記し、
  query は最新の検証済み提出を見る）。刻印する SHA はエンジンが決める — 通常は提出時の
  worktree head、verdict は launch 時に pin した検証対象の SHA（§6.1）。verdict の pin は
  `launch-step` の入力合成で確立されるので、pin の無い提出（`launch-step` を経ない
  エージェントなし運用、§9.4）では**提出時の現 head を検証対象とみなして刻印する** — 提出者
  自身が検証対象の版を選んでいるため、launch pin と同じ「検証した版」の意味を保つ。
- **受理（記録）と配置は別の関心事**: 検証が通るとまず `workflow_artifacts` に正本として記録し
  （= 受理）、続けて run の責務として配置（§6.4）まで同期的に行ってから成功を返す。配置に
  失敗した場合（PR 更新エラー等）は非ゼロで返すが、**記録は取り消さない** — 再実行時は記録済み
  artifact の配置だけをやり直す（冪等）。「受理済みだが未配置」は step status から観測できる
  未完了状態であり（§6.5 — 完了は配置まで要求する）、run が解消する責務を持つ。成功時は
  配置先を 1 行で表示する。

### 6.4 placement policy

検証済み artifact をドメインへ配置する対応は **core の単一箇所**（`core/workflow/placement.ts`、
後続実装）に集約する。契約・子・親のいずれにも現れない:

| artifact | 配置先 | 付随処理 |
|---|---|---|
| plan | linked PR body の実装計画 section（placeholder を rendered markdown で置換） | — |
| execution-report | PR body の Summary / Acceptance criteria / Test plan / Evidence section（rendered） | **draft → ready を LoopHub が行う**（従来子が実行していた `lh pr ready-for-review` は子の仕事でなくなる）。`evidence[].path` のファイルは attachment として upload し、embed markdown に変換して Evidence に載せる |
| verdict | 刻印 SHA に対する PR review（`event` を pass / request_changes として提出） | — |
| reflection | PR への構造化 comment（rendered） | marker（`<!-- workflow:reflect -->`）は付けない — 完了判定は配置記録で行う（§6.5） |

配置の位置づけを明確にする: **artifact の正本は `workflow_artifacts`（PR 非依存、§5.2）であり、
配置はその正本を run が紐づくドメインへ投影する行為**である。run（v1 では常に PR に紐づく）が
この投影と台帳（`workflow_placements`）の管理責務を負い、artifact 本体は配置先を知らない。
placement policy はその投影規則であって、artifact のデータモデルの一部ではない — したがって
**workflow のコア（schema・契約・合成・完了評価）は PR に依存せずに設計されている**。PR を
持たない run というユースケースは v1 には無いが、その拡張はこの境界（§14）を保てば placement
の差し替えだけで済む。

人間が PR 上で読むもの（実装計画、Summary / Evidence、review、reflection comment）は従来と
同じに保たれる — 変わるのは「誰が書くか」（子が `lh pr update` する → エンジンが配置する）
だけである。

### 6.5 完了判定 — 検証済み artifact の配置有無の query

step の完了は「**検証済み artifact が配置されているか**」の query で判定する。#976 §14 の決定
（`step complete` / `advance` のような宣言・遷移コマンドは作らない）は維持する — `step output`
は成果物の提出であって完了宣言ではなく、完了は常に配置記録から計算される。

| step | 完了条件 |
|---|---|
| Plan | 検証済み plan artifact が配置されている。 |
| Execute | 検証済み execution-report artifact が配置されていて **刻印 SHA == 現 head**、かつ head が base より先行している。 |
| Verify | 検証済み verdict artifact が配置されていて **刻印 SHA == 現 head**。 |
| Reflect | 検証済み reflection artifact が配置されている。 |

- PR body の placeholder 置換検知・`<!-- workflow:reflect -->` marker 検索のような**ドメイン表現への
  marker ヒューリスティックは全廃**する。ドメイン上の表現（PR body の section、review、comment）
  は placement の**出力**であって、判定の**入力**ではない。
- head 依存 step（Execute / Verify）は SHA 比較だけで stale を検知できる: 差し戻しで head が
  進めば execution-report も verdict も自動的に incomplete へ戻る。
- query の実装は `core/workflow/steps.ts`（pure — `workflow_artifacts` の最新検証済み提出 + その配置
  記録（`workflow_placements`）+ 現 head を入力に評価）で、`lh workflow step status` として公開する
  （§9.4）。「受理済みだが未配置」（§6.3 の配置失敗）は incomplete として現れる。子の自己申告
  （pane 出力の「done」等)を完了の根拠にしない点は従来どおり — 親の遷移判断は herdr 非依存の
  まま（§8）。

### 6.6 契約の構成 — repo / issue 非依存の汎用文書

契約は step ごとに固定の markdown template として **LoopHub repo（git）の
`core/workflow/contracts/<step>.md`** に置く。ユーザーは編集できない（変更は LoopHub 本体への PR）。
各契約は次の 4 部で構成する: **入力（どのファイルが渡されるか）・成果物（提出する artifact の
型と内容）・完了条件（提出が成功すること）・禁止事項**。

#981 の改訂で、契約テキストは **repo / issue 非依存の汎用文書**になる:

- 契約は issue id / PR id / 配置先（PR body / review / comment）・取得手段（`lh issue view` /
  `lh pr update` / `lh pr review` 等）に言及しない。
- 契約が言及してよい固有名は「渡された入力ファイル」「worktree」「`lh workflow step output`」
  だけである。
- したがって同じ契約文書が、どの repo・どの issue の run でもそのまま使える。契約 template に
  埋める変数も worktree path・base branch・step 名だけになる（§7.2）。

### 6.7 Plan

| 項目 | 内容 |
|---|---|
| 入力 | `task.md`（実現したい要求 — 背景、done 条件、受け入れ基準、スコープ外）、worktree のコード（読取）。 |
| 成果物 | **plan artifact**（§6.2）を `lh workflow step output` で提出する。内容: 変更する領域、再利用する既存 API・module、スコープ境界、検証方法。 |
| 完了条件 | 提出が成功する（検証を通って受理され、エンジンが配置まで完了して成功を返す — §6.3）。 |
| 禁止事項 | source の編集・commit。`lh workflow step output` 以外の書き込み。 |

### 6.8 Execute

| 項目 | 内容 |
|---|---|
| 入力 | `task.md`、`plan.md`（承認済みの実装計画）、worktree。**差し戻し時は追加で**: `findings.md`（現在の変更への指摘 — どの版への指摘かの SHA を含む）と親からの note（§8.3）。 |
| 成果物 | (1) worktree の head branch への **commits**（テスト green。repo 標準のテスト・lint・typecheck を実行する）。(2) **execution-report artifact** の提出 — summary、受け入れ基準ごとの充足、テスト結果、evidence。**最後の commit の後に提出する**（提出時の worktree head が刻印されるため、提出後に commit すると report は stale になる）。 |
| 完了条件 | head が base より先行していて、現 head での execution-report の提出が成功する（ready 化は配置の付随処理としてエンジンが行う — 子の仕事ではない、§6.4）。 |
| 禁止事項 | merge 操作。worktree 外の編集。自分の変更の合否判定（Verify の代行）。`lh workflow step output` 以外の提出手段。 |

### 6.9 Verify

| 項目 | 内容 |
|---|---|
| 入力 | `task.md`（受け入れ基準を含む）、`changes.diff`（検証対象の変更 — 特定 SHA に pin、§7.3）、`report.md`（実装者の主張 — execution-report のレンダリング）、`prior-verdicts.md`（あれば — 過去の判定と指摘。差し戻し後の再検証では前回指摘の解消確認に使う）、worktree（読取。テストの再実行は可）。 |
| 成果物 | **verdict artifact** の提出 — `pass` / `request_changes`、指摘は file:line・問題・期待する状態。実装者の主張（report）を鵜呑みにせず自分で検証する。 |
| 完了条件 | 提出が成功する。 |
| 禁止事項 | source の編集（読取専用 — 見つけた問題を自分で直さない。独立性を保つ）。実装者への直接の指示（指摘は verdict に書く）。 |

### 6.10 Reflect

| 項目 | 内容 |
|---|---|
| 入力 | `run-digest.md`（run の全経過 — 要求、計画、実行報告、判定と指摘、差し戻し回数、時系列）。 |
| 成果物 | **reflection artifact** の提出 — うまくいったこと / 詰まったこと・差し戻しの原因 / step prompt・契約への改善提案 / 後続 issue 候補。 |
| 完了条件 | 提出が成功する。 |
| 禁止事項 | source の編集。worktree への書き込み。 |

### 6.11 全 step 共通の契約条項

- 作業は渡された worktree 内で行う。
- 子の出力経路は `lh workflow step output` だけである。ドメインを読む・書くコマンド
  （`lh issue view` / `lh pr update` / `lh pr review` / `lh pr comment` 等）は使わない —
  必要な情報はすべて入力ファイルとして渡されている。入力に無い情報が必要になったら、それは
  入力合成の欠陥なので、探しに行かずに停止して報告する（親が停滞として検知する、§8）。
- slash command（`/lh-*` 等）を呼ばない。skill に依存せず、この契約と step prompt だけで働く。
- 提出が成功したら短く結果を報告して停止する（次の作業を自分で始めない — 次 step の起動は
  親の責務）。
- step prompt は「この契約の範囲内でのカスタマイズ」である。**step prompt と契約が矛盾する
  場合、契約が優先する**（この一文自体を契約 template に含める）。

---

## 7. 入力の合成と挿入機構

### 7.1 channel の分離

子 agent の起動 argv と環境は **LoopHub（`lh workflow launch-step`）だけが合成する**。契約と
ユーザー prompt は別 channel で渡す:

```sh
LOOPHUB_WORKFLOW_RUN=<run-id> LOOPHUB_WORKFLOW_STEP=<step> \
claude \
  --session-id <uuid> \
  --append-system-prompt-file "$LOOPHUB_HOME/runs/workflow/<run-id>/<step>-contract.md" \
  [--permission-mode auto] \
  "<composed user prompt>"
```

- **契約** = `core/workflow/contracts/<step>.md`（固定 template）に worktree path・base branch・
  step 名を埋めたもの（repo 名や issue / PR 番号は埋めない — 契約は repo / issue 非依存、
  §6.6）。launch 時に run ディレクトリへ書き出し、`--append-system-prompt-file` で
  **system prompt に追加**する。
- **環境変数** = ambient run context（`LOOPHUB_WORKFLOW_RUN` / `LOOPHUB_WORKFLOW_STEP`）。
  `lh workflow step output` の提出先を特定するためだけの opaque な識別子（§6.3）。
- **user prompt**（positional）は LoopHub が次の形に合成する。ドメイン識別子
  （repo / issue / PR 番号）は載せない:

  ```text
  ## Inputs
  <入力 artifact ファイルの一覧 + 1 行説明（§7.3）。パスは run directory の絶対パス。例:>
  - $LOOPHUB_HOME/runs/workflow/<run-id>/<step>/input/task.md — 実現したい要求と受け入れ基準
  - $LOOPHUB_HOME/runs/workflow/<run-id>/<step>/input/plan.md — 承認済みの実装計画
  worktree: .（cwd。base branch: <name>）

  ## Step prompt (user-configured)
  <DB の <step>_prompt。空なら「(none — follow the contract)」>

  ## Note from the workflow agent
  <親が --note で渡した追加指示。差し戻し理由など。無ければ省略>
  ```

### 7.2 上書き・省略できない境界

ユーザーが触れる入力は「DB の step prompt」と「issue / PR の本文（入力 artifact に合成される、
§7.3）」だけで、いずれも **positional user prompt の 1 section または入力ファイルにしか
現れない**。契約側の channel（`--append-system-prompt-file` の内容）に至る経路にユーザー入力は
存在しない:

- 契約 template は git 管理の LoopHub 同梱ファイル。DB・設定・step prompt から内容を差し込む
  変数は存在せず、埋めるのは worktree path・base branch・step 名だけ（§6.6）。
- argv・環境の合成は `lh workflow launch-step` の中で行われ、親にも文字列を渡さない（親は
  run id と step 名と note を指定するだけ）。親の裁量でも契約を外せない。
- step prompt・issue 本文に何を書いても、system prompt の契約は必ず存在する。

この保証は **channel レベル（構造的）** のものである。「モデルが契約に従うか」という意味論
レベルの保証ではない — step prompt に契約へ背く指示を書けば、モデルが混乱することはあり得る。
それは §6.11 の優先順位条項（契約 > step prompt）と、**完了が検証済み artifact の配置で定義
されている**こと（背いた場合は schema 検証か完了条件で止まり、親が停滞として検知する）で
受け止める。

### 7.3 入力 artifact の合成 — 出力との対称性

入力側も出力側と対称にする: **子は取得手段（`lh issue view` / `lh pr diff` 等）や出所
（issue / PR / review）を知らずに、launch 時に合成された入力を受け取る。**

- `lh workflow launch-step` が、ドメイン状態から step ごとの入力 artifact を**ファイルとして**
  run ディレクトリ（`$LOOPHUB_HOME/runs/workflow/<run-id>/<step>/input/`）へ書き出し、user prompt
  にはファイル一覧と 1 行説明だけを載せる（§7.1）。**user prompt に載せるパスは run directory
  の絶対パス** — worktree へは copy しない（git tree を汚さず、入力ファイルの commit への混入を
  防ぐ）。
- **大きい入力（長い issue、巨大 diff）を prompt に直接埋め込まない。** ファイル参照なら子は
  必要な部分だけを読める（context を溢れさせない）。
- 合成の対応（どのドメイン状態からどの入力ファイルを作るか）は placement policy と対になる
  core の単一箇所（`core/workflow/inputs.ts`、後続実装）に置く。

| step | 入力ファイル | 合成元（エンジンだけが知る） |
|---|---|---|
| Plan | `task.md` | issue の title + body + 全 comments |
| Execute | `task.md`、`plan.md`、差し戻し時 `findings.md` | issue、配置済み plan artifact、最新 verdict の findings（どの SHA への指摘かを付記） |
| Verify | `task.md`、`changes.diff`、`report.md`、差し戻し後 `prior-verdicts.md` | issue（AC を含む）、launch 時 head SHA に pin した `git diff <base>...<sha>`、配置済み execution-report、過去の verdict artifact（差し戻し後のみ存在） |
| Reflect | `run-digest.md` | run の全 artifact + rework 回数 + 時系列（handoff 記録を含む） |

- **diff は launch 時点の head SHA に pin する。** 子が検証している間に head が動いても入力は
  変わらない — その場合は verdict の刻印 SHA が現 head と一致せず完了判定が incomplete のまま
  になる（§6.5）ので、親が Verify を再起動する。
- `task.md` は issue の本文を忠実に写す（要約しない）。本文中に issue 番号等が現れることは
  あるが、契約も prompt もその利用を要求しない — 子にとってはただの要求文書である。

### 7.4 親への挿入

親も同じ機構で起動する: 親契約 `core/workflow/contracts/parent.md`（責務・遷移表・使ってよい
コマンド）を `--append-system-prompt-file` で挿入し、positional prompt には run context だけを
渡す。**親にはユーザー設定 prompt がない**（v1）。orchestration の挙動をユーザーが変えたく
なった場合は、それが本当に必要かを含めて後続 issue で扱う。

---

## 8. 親（workflow agent）の責務と遷移判断

### 8.1 責務

1. **run 状態の報告** — step 遷移のたびに `lh workflow run update --run <id> --step <step>`
   で run row を更新する（UI 表示用。真実は配置済み artifact と現 head の対応であり run row は
   その写し、§5.2）。
2. **子の起動** — `lh workflow launch-step --run <id> --step <step> [--note <text|->]`。
   herdr の split pane（`agent start --tab <run tab> --split down`）で run の worktree を cwd に
   起動される。合成は LoopHub、タイミングと note の判断は親。
3. **遷移判断** — §8.2 の表に従い、**step status（配置済み artifact の query、§6.5）だけ**を
   根拠に次 step へ進む。
4. **停滞検知とつつき** — `herdr agent wait <child> --status idle --timeout <ms>` で子の停止を
   検知し、成果物が完了条件に達していなければ `herdr pane run <pane> "<不足の指摘>"` で注入
   する。herdr から得る情報は**停滞検知と催促にだけ**使い、遷移の根拠にしない。
5. **差し戻し** — Verify が request_changes を出したら Execute へ戻す（§8.3）。
6. **エスカレーション** — 差し戻しやつつきが上限を超えたら人間へ引き継ぐ（§8.4）。
7. **終了処理** — Reflect 完了で run を `completed` にして停止する。**merge はしない**（人間の
   責務）。

親は自分ではコードを書かない・レビューしない・PR body を書かない。判断と調整だけを行う。

### 8.2 LoopHub から取得する情報と遷移基準

| 監視対象 | 取得方法 | 判断 |
|---|---|---|
| step の完了 | `lh workflow step status <run> --json`（配置済み artifact + 現 head の query、§6.5） | plan complete → **Execute へ**。execute complete → **Verify へ**。verify complete かつ最新 verdict が pass → **Reflect へ**。reflect complete → **run 完了** |
| 最新 verdict の内容 | 同上（status は最新 verdict の `event` と findings 要約を含める） | `request_changes` → **差し戻し（§8.3）** |
| event snapshot | `lh events --since <id> --order asc --repo <r> --json` | bounded polling で `pull_request.updated` / review 系 event を起床トリガーに使い、処理後に cursor を進める |
| issue の状態 | `lh issue view <n> --json` | issue が close された等の外部変化 → run を `stopped` にして終了 |

event snapshot は遷移の真実ではなく、`lh workflow step status` を再評価するための wake-up hint
として扱う。親の起動時・再起動時は最初に `step status` を評価し、その後
`lh events --order desc --repo <r> --json` の先頭 id（event がなければ `0`）を cursor にして
過去の hint を捨てる。この設計では cursor を再起動後まで永続化する必要はない。実行中は 1 秒ごとに
ascending snapshot を取得し、空なら同じ cursor のまま待つ。event があれば id 順に扱って最大 id へ
進め、100 件返った場合は backlog を drain するため待たずに再取得する。具体的な consumer loop は
[`breaking-changes.ja.md`](breaking-changes.ja.md) の migration 例を参照する。

`launch-step` は起動時に `lh handoff record --phase <step> --dir down` で「親→子に何を渡したか」
を記録する。子の成果物は artifact として記録・配置されるので `--dir up` の明示記録は必須に
しない。受け渡し記録（`lh handoff list`）は Reflect の入力合成の素材として**エンジン**が使う
（§7.3）— 親の監視対象ではなく、遷移判断にも使わない。

完了条件の評価は、親が生の JSON を解釈するのではなく、core の pure な評価関数（§12）に実装して
`lh workflow step status` として公開する（§9.4）。真実は配置済み artifact（`workflow_artifacts` ×
`workflow_placements`）と現 head の対応であり、status は呼ばれるたびにそこから計算される **query**
である。これにより
親の遷移判断は「status を取得し、表に従って行動する」に縮み、判定ロジック自体はエージェント
なしで unit test できる。親はドメイン識別子（issue / PR 番号）を run context として知っている
（エスカレーション等で使う）が、**子は知らない**（§6.1）— ドメインとの境界はエンジンが一手に
持つ。

### 8.3 差し戻し（request_changes → Execute）

1. `rework_count` を +1（`lh workflow run update`）。上限（v1 は 3 回固定）超過なら §8.4 へ。
2. Execute の子 pane がまだ生きていれば（`herdr agent get`）、`herdr pane run` で findings への
   対応を指示する — session の文脈を保てるので優先する。
3. pane が閉じていれば `lh workflow launch-step --step execute [--note <補足>]` で再起動する。
   最新 verdict の findings は**エンジンが `findings.md` として合成する**（§7.3）ので、note は
   親の補足があるときだけでよい。
4. Execute が新 head で execution-report を再提出したら（§6.5 で execute が complete に戻る）、
   **Verify を新しい子として再起動**する。同じ reviewer session は使い回さず、常に新規起動する
   （§14 の決定。前回指摘の解消確認は、fresh な子が §6.9 の入力 `prior-verdicts.md` を読むこと
   で行う）。

### 8.4 エスカレーション

- 条件: rework 上限超過、同一 step へのつつき 2 回で完了条件に達しない、子の起動失敗の繰り返し、
  worktree の conflict 等 agent では解けない状態。
- 動作: (1) 経緯の要約を issue に comment（`lh issue comment`）。(2) `lh inbox send` で人間へ
  Inbox 通知。(3) run を `blocked` に更新して親は停止する。
- 再開: v1 では自動 resume を持たない。人間が状況を解消して `lh workflow start` を再実行する
  （openPr が冪等なので既存 PR・worktree をそのまま使って新しい run が始まる）。

---

## 9. 起動経路（UI / RPC / CLI）

### 9.1 UI — Start workflow ボタン

- 置き場所: issue detail のアクション行（`web/src/components/issue-detail.tsx` の
  `BuildControls` の隣）。**[Build] [Start workflow ▾]** と並ぶ。
- Start workflow はドロップダウンで **保存済み workflow を名前で選んで起動**する
  （`workflows/list` を表示。0 件なら Settings の Workflows ページへの導線を出す）。
- 表示条件は Build と同じ判定を使う: linked open PR が既にある issue では Build 同様に起動系
  ボタンを出さない（1 issue につき同時 1 系統。Build と Workflow run は同じ soft guard —
  「open PR は同時に 1 つ」— を共有する）。

### 9.2 RPC

`terminal/launch` の `workflow` enum に `"workflow-run"` を追加し、params に `workflowId` を
足す。server 側（`core/service/terminal.ts`）は `launchIssueDevHerdr` と同型の
`launchWorkflowRunHerdr` で `lh workflow start <owner>/<repo>/<n> --workflow-id <id> --herdr` を
spawn する。既存の Build 経路（RPC → CLI spawn → herdr）と同じ形にすることで、worktree /
PR / lock の準備ロジックを CLI 側に一本化したままにする。

変更が要る箇所は Build ボタンと同じ 4 点セット: `web/server/contract.ts` の enum、
`web/src/api/client.ts`、`web/src/components/terminal-controller.tsx`、
`core/service/terminal.ts`。

### 9.3 CLI

```sh
lh workflow start <owner>/<repo>/<issue> | <issue> [--repo owner/name] \
  (--workflow <name> | --workflow-id <id>) [--herdr] [--auto] [--model <m>] [--no-launch]
```

`lh build` と同じ準備（openPr・worktree provision・dev lock・session 登録）を行い、slash
command の代わりに §7 の合成で親を起動する。`--herdr` なしの foreground 起動も `lh build` と
同じ扱いで提供する（親だけ foreground、子は常に herdr pane — herdr が無い環境では v1 は
起動をエラーにする。子の起動が herdr 前提のため）。

runtime / model / permission は既存の `agents` / `codingAgent` 設定と flag をそのまま使う
（#964 §4.2 と同じ整理: step は runtime を持たない）。v1 は claude runtime のみ（§14）。
`--no-launch` は run と draft PR / worktree の準備だけ行い、親を起動しない — §9.4 の
エージェントなし運用・テスト用。

### 9.4 step の入出力を CLI で表現する — エージェントなしで動かす

step の interface は「入力（LoopHub が合成する契約 + 入力 artifact + prompt）」と「出力
（`step output` で提出する artifact）」だけである。これを `lh workflow` のコマンドとして
公開する:

```sh
lh workflow step input <run> <step> [--note <text|->]     # 合成される入力を表示する dry-run（起動しない）
lh workflow step output [--run <id> --step <step>] [--file <path|->]
                                                           # 出力 artifact の提出（検証 → 刻印 → 配置）
lh workflow step status <run> [--json]                    # 各 step の完了条件の評価結果（満たされた / 欠けているもの）
                                                           # + 最新 verdict の要約（event / findings、§8.2）
```

- `step input` は `launch-step` と同一の合成を行い、契約（system prompt 側）・入力 artifact
  ファイル・user prompt を表示だけする。channel 分離の unit test（ユーザー入力が契約 channel に
  混入しない、§13）は合成の実体である `core/workflow/compose.ts` を直接 assert する。`step input`
  は同じ合成結果を人間の確認とエージェントなし e2e（§13）に使うための窓である。
- `step output` は提出の唯一の入口（§6.3）。子は**引数なし**で呼ぶ — run / step は ambient run
  context（launcher が注入する `LOOPHUB_WORKFLOW_RUN` / `LOOPHUB_WORKFLOW_STEP`）から解決する。
  `--run` / `--step` は人間・テストが ambient context なしで提出するための明示指定
  （flag が env に優先する）。artifact JSON は `--file <path>` または stdin（`-`、既定）。
  検証（§6.3）を通れば配置（§6.4）まで同期的に行い、配置先を 1 行で表示する。検証エラーは
  非ゼロ exit + 違反項目の列挙（422 相当）で、何も記録・配置しない — 子は修正して再提出する。
- `step status` は **query であって actuator ではない**。完了を宣言する `step complete` や、
  status に基づいて次 step を自動起動する `advance` は作らない（§14）。`step output` も完了
  宣言ではない — 成果物（artifact）の提出であり、完了は常に配置記録と現 head から計算される
  （§6.5）。進める判断は親に残す。出力には completion の complete / missing に加えて
  **最新 verdict の要約（`event` と findings の件数・概要）**を含める — §8.2 の親の差し戻し
  判断（request_changes → Execute へ）はこの field に依存する。

workflow と run の準備（`lh workflow create` / `lh workflow start --no-launch`）の後は、この
3 つと worktree での git 操作だけで、**エージェントを 1 つも起動せずに run を最初から最後まで
動かせる**。artifact
を人間（またはテスト）が `step output` で提出すれば、workflow はそれを完了として観測する —
step の実行主体が agent / 人間 / テストスクリプトのどれであっても、interface は同じである。
従来の手動 e2e で必要だった `lh pr update` / `lh pr ready-for-review` / `lh pr review` /
`lh pr comment` の直接呼び出しは不要になる（すべて placement policy がエンジン側で行う）。

実行例（テスト・動作確認）:

```sh
# 0) workflow を作る（step prompt は空でもよい — 契約だけで step は成立する）
$ lh workflow create standard
created workflow "standard" (id 1)

# 1) run を開始 — 親は起動しない
$ lh workflow start jugyo/loophub/42 --workflow standard --no-launch
run #7: issue #42 -> PR #43 (draft) / worktree ~/.loophub/worktrees/jugyo/loophub/pr-43

# 2) Plan に渡る入力を確認（dry-run）
$ lh workflow step input 7 plan
--- system prompt (contract: plan) ---
（core/workflow/contracts/plan.md に worktree path / base branch / step 名を埋めたもの）
--- input files ---
~/.loophub/runs/workflow/7/plan/input/task.md — 実現したい要求と受け入れ基準（エンジンが issue #42 から合成）
--- user prompt ---
## Inputs
- ~/.loophub/runs/workflow/7/plan/input/task.md — 実現したい要求と受け入れ基準
worktree: .（base branch: main）
## Step prompt (user-configured)
(none — follow the contract)

# 3) 完了条件を確認 — まだ何も配置されていない
$ lh workflow step status 7 --json
{ "run": 7,
  "steps": {
    "plan":    { "complete": false, "missing": ["no validated plan artifact placed"] },
    "execute": { "complete": false, "missing": ["no validated execution-report for current head", "head equals base"] },
    "verify":  { "complete": false, "missing": ["no validated verdict for current head"],
                 "latest_verdict": null },
    "reflect": { "complete": false, "missing": ["no validated reflection artifact placed"] } } }
# verify の latest_verdict は、verdict 配置後は { "event": "pass|request_changes",
# "findings": <件数と要約> } になる — 親の差し戻し判断（§8.2）が読む field

# 4) Plan の artifact をエージェントの代わりに手で提出する（検証 → 配置）
$ lh workflow step output --run 7 --step plan --file plan.json
validated: plan → placed: PR #43 body (implementation plan section)
$ lh workflow step status 7 --json | jq .steps.plan.complete
true

# 4') schema 違反は 422 相当 — 何も配置されない
$ echo '{"type":"plan","summary":""}' | lh workflow step output --run 7 --step plan
error 422: invalid plan artifact:
  - summary: must be non-empty
  - changes: required (at least 1 item)
  - verification: required

# 5) Execute: commit してから execution-report を提出（ready 化はエンジンが行う）
$ git -C ~/.loophub/worktrees/jugyo/loophub/pr-43 commit --allow-empty -m "impl"
$ lh workflow step output --run 7 --step execute --file report.json
validated: execution-report (head 1a2b3c4) → placed: PR #43 body + draft→ready
$ lh workflow step status 7 --json | jq .steps.execute.complete
true

# 6) Verify: verdict を提出（review の投稿はエンジンが行う）
$ echo '{"type":"verdict","event":"pass","summary":"AC satisfied; tests green","findings":[]}' \
    | lh workflow step output --run 7 --step verify
validated: verdict (head 1a2b3c4) → placed: review (pass) on PR #43

# 7) Reflect: reflection を提出（comment の投稿はエンジンが行う）
$ lh workflow step output --run 7 --step reflect --file reflection.json
validated: reflection → placed: comment on PR #43
$ lh workflow step status 7 --json | jq '[.steps[].complete] | all'
true
```

通常運用（親を herdr で起動する）でも同じ query を使う — 親は遷移判断に、
人間は run の進行を覗くのに:

```sh
# 別の issue で通常どおり親を起動した run
$ lh workflow start jugyo/loophub/57 --workflow standard --herdr
run #8: issue #57 -> PR #58 (draft) / workflow agent started in herdr pane

$ lh workflow step status 8
plan     complete
execute  incomplete — no validated execution-report for current head
verify   incomplete — no validated verdict for current head
reflect  incomplete — no validated reflection artifact placed
```

---

## 10. skill 非依存の確認

入口から子まで、各ホップで agent に渡る prompt の出所を列挙する:

| ホップ | prompt / 指示の出所 | skill / slash 依存 |
|---|---|---|
| Start workflow ボタン → `terminal/launch` | 構造化パラメータのみ（prompt なし） | なし |
| RPC handler → `lh workflow start` spawn | argv のみ | なし |
| `lh workflow start` → 親起動 | 親契約 = `core/workflow/contracts/parent.md`（git 同梱）+ run context | なし |
| 親 → `lh workflow launch-step` → 子起動 | step 契約 = `core/workflow/contracts/<step>.md`（git 同梱）、入力 artifact = エンジンがドメイン状態から合成（§7.3）、step prompt = DB（`workflows`）、note = 親の自由記述 | なし |
| 子 → LoopHub | `lh workflow step output` のみ（artifact の提出、ambient run context） | なし |

- 合成されるどの prompt にも slash command 呼び出しを含めない。契約 template に「slash
  command を呼ばない」を明記する（§6.11）。
- `SKILL.md` を読む箇所、`~/.claude/skills` / `npx skills add` の配布状態に依存する箇所が
  経路上に存在しない。skill が 1 つもインストールされていない host でも workflow は
  動作する。
- 実装時の検証: 合成 prompt（契約 + user prompt）に `/lh-` パターンが含まれないことの unit
  test、および skill を配布していない環境での end-to-end 手動確認をチェックリストに含める
  （§13）。

なお「skill 非依存」は「agent host 非依存」ではない — claude CLI と herdr は前提である。

### 10.1 ドメイン非依存の確認 — 子は issue id / PR id / 出力先を知らない

子に渡る情報を全列挙して、どの step もドメイン識別子なしで完了できることを確認する:

| 経路 | 内容 | ドメイン識別子の利用要求 |
|---|---|---|
| system prompt（契約） | 入力ファイル・worktree・`step output` の取り決めだけ。repo / issue / PR に言及しない（§6.6） | なし |
| user prompt | 入力ファイル一覧 + step prompt + note。ドメイン識別子は載せない（§7.1） | なし |
| 入力ファイル | task / plan / findings / diff / report / prior-verdicts / run-digest（§7.3）。本文中に issue 番号等が現れうるが、ただのテキスト | なし |
| worktree | cwd。branch 名（`loophub/pr-<m>`）に PR 番号が含まれるが、契約は branch 名の解釈を要求しない | なし |
| 環境変数 | `LOOPHUB_WORKFLOW_RUN` / `LOOPHUB_WORKFLOW_STEP` — 提出先を特定する opaque な値。子は読まない（`step output` が読む） | なし |
| 出力 | `lh workflow step output` — 引数なし。artifact schema にドメイン識別子の field はない（§6.2） | なし |

全 step（Plan / Execute / Verify / Reflect）の成果物提出に issue id / PR id / 出力先の知識が
不要であり、契約テキストは repo / issue 非依存の汎用文書として成立する。

---

## 11. #964（workflow instruction 管理モデル）との関係

`docs/workflow-instruction-model.ja.md`（#964 / PR #966）は、既存の skill ベースの入口を
workflow / step / instruction binding として宣言化し、binding の差し替えを 4 層設定で管理する
モデルを定義した。本書との関係は **置換でも統合でもなく、併存する実験**である。

| 観点 | #964 モデル | 本書（Workflow） |
|---|---|---|
| instruction の実体 | skill（`SKILL.md`、git + `npx skills add` 配布） | LoopHub 同梱契約（git）+ inline step prompt（DB） |
| step の実行形態 | entry step の launch + 本文内 chain（`execution: "chained"`） | すべて親が起動を仲介する launch |
| ユーザーの自由度 | binding（どの instruction を使うか）の差し替え | 契約内での step prompt の記述 |
| 手順の骨格の所有者 | skill 本文（chain は本文に埋まる） | LoopHub（契約と親） |

明文化する取り決め:

- **併存（実験扱い）。** 既存 skill chain は変更せず、Build ボタンの隣に Workflow の入口が増える
  だけである。#964 の catalog（`loophub@1`）にも workflow は **v1 では登録しない** —
  catalog は immutable versioned であり、実験段階の Workflow を載せると変更のたびに catalog
  version が要る。同様に #964 の `WorkflowConfig`（binding override）の対象にもならない。
- **#964 の語彙との整合。** #964 の用語で言えば、Workflow run は「すべての step が
  `execution: "launch"` で、instruction の delivery が skill ではなく inline な entrypoint
  workflow」である。#966 §8 は将来の delivery 拡張（`kind: "prompt"` 等の tagged union）を
  予約しており、Workflow の step prompt はその具体例になる。また #966 §4.3 は「将来 LoopHub が
  step 起動を仲介するモデル」への移行を展望しており、**Workflow の親仲介 launch はその実証実験を
  兼ねる**。
- **昇格の条件。** 実験が定着したら、後続 issue で (1) catalog の新 version に Workflow 系
  workflow を登録し、(2) instruction delivery に inline 種別を追加し、(3) 4 step 固定の緩和や
  binding との統合を必要に応じて設計する。定着しなければ、DB テーブルと UI・CLI を落とすだけで
  skill / catalog 世界には何も影響しない — これが「実験扱い」の設計上の意味である。
- **用語の衝突回避。** 「workflow」という語は 3 つある: #964 の workflow（宣言化された作業
  単位）、repo automation（`.loophub/workflow.yml`）、本書の workflow。ドキュメント・UI
  では workflow を単に「Workflow」と表示してよいが、設計文書では workflow と
  呼び分ける。

---

## 12. 実装境界

後続 issue で実装する場合の責務分担:

| 層 | 責務 |
|---|---|
| `core/workflow/contracts/*.md`（新規） | 親・4 step の契約 template（git 管理）。repo / issue 非依存の汎用文書（§6.6）。 |
| `core/workflow/artifacts.ts`（新規） | 4 つの artifact 型の schema と pure な検証（JSON → ok / 違反リスト）。DB / fs を読まない。 |
| `core/workflow/placement.ts`（新規） | placement policy の単一箇所 — 検証済み artifact 型 → ドメイン書き込み（PR body section / review / comment、draft→ready、attachment 化）の対応と、配置台帳（`workflow_placements`）の管理（§6.4）。ドメインに触れるのはここ・`inputs.ts`・run 開始だけ（§14）。 |
| `core/workflow/inputs.ts`（新規） | 入力 artifact の合成の単一箇所 — step ごとの「どのドメイン状態からどの入力ファイルを作るか」（§7.3）。pure な合成と fs 書き出しを分離する。 |
| `core/workflow/compose.ts`（新規） | 契約 + 入力ファイル一覧 + step prompt + note の pure な合成（§7.1）。DB / fs を読まない。 |
| `core/workflow/steps.ts`（新規） | step 完了条件の pure な評価（`workflow_artifacts` の最新検証済み提出 + `workflow_placements` の配置記録 + 現 head → complete / missing + 最新 verdict の要約、§6.5・§8.2）。DB / fs を読まない。 |
| `core/db.ts` / `core/store/workflows.ts`（新規） | `workflows` / `workflow_runs` / `workflow_artifacts` / `workflow_placements` の schema・migration・CRUD。 |
| `core/service/workflows.ts` / `core/service/workflow-runs.ts`（新規） | workflow CRUD（validation、`422`）、run 開始（`dev.openPr` / worktree provision / dev lock の再利用）、launch-step の入力合成と herdr 起動、step output の検証・刻印・配置（artifacts / placement の合成）、run update。 |
| `core/terminal/terminal-launch.ts` | split pane 起動 argv（`--split` 対応の builder 追加）。既存 builder の流儀に従う。 |
| `cli/commands/workflow.ts`（新規） | `lh workflow start / launch-step / step input / step output / step status / run update / list / view / create / update / delete`。thin に保ち、判断は service へ。 |
| `web/server/contract.ts` / `core/service/terminal.ts` | `terminal/launch` の `"workflow-run"` 拡張、`workflows/*` RPC。 |
| `core/serialize.ts` | workflow / run の wire shape（`web/src/api/types.ts` は型再宣言しない）。 |
| `web/src/components/issue-detail.tsx` ほか | Start workflow ボタン（dropdown）、run 状態表示。 |
| `web/src/routes/settings` 配下 | Workflows 編集ページ。 |

---

## 13. 後続 issue 向けチェックリスト

上から順に依存が薄い:

- [ ] `workflows` の schema / store / service CRUD + `lh workflow list/view/create/update/delete`
      + `workflows/*` RPC（UI なしで CRUD が成立する縦切り）。
- [ ] `core/workflow/artifacts.ts` — 4 つの artifact 型の schema と検証。unit test: 型ごとの正常系 /
      違反系（欠落 field・空文字・不正 enum・request_changes で findings 0 件、等）。
- [ ] `core/workflow/contracts/*.md`（親 + 4 step）と `core/workflow/compose.ts` / `core/workflow/inputs.ts`。
      合成の unit test: 契約が必ず system prompt 側 channel に載る / ユーザー入力が契約 channel に
      混入しない / 合成 prompt に slash command を含まない / 契約・user prompt にドメイン識別子
      （issue / PR 番号）を差し込まない（§6.6、§7.1）。
- [ ] `workflow_runs` + `lh workflow start`（openPr・worktree・lock 再利用、親の herdr 起動）。
- [ ] `lh workflow launch-step`（入力 artifact の合成・書き出し、split pane 起動、ambient run
      context の環境変数注入、handoff 記録、session 登録）+ `lh workflow run update`。
- [ ] `lh workflow step output` + `workflow_artifacts` / `workflow_placements` + `core/workflow/placement.ts`
      （検証 → 記録 → 配置、draft→ready、検証エラー 422、配置失敗時の記録保持と再試行、
      §6.3–6.4）。unit test は placement の対応表と刻印を、e2e は「提出 → PR 上の表現」を
      assert する。
- [ ] `lh workflow step input` / `step status`（`core/workflow/steps.ts` の完了条件評価 + 合成 dry-run、
      §9.4）と、エージェントなしで 4 step を通す e2e テスト（artifact を `step output` で人工的に
      提出し、status の complete / missing と配置結果を assert する。head を進めて execution-report /
      verdict が stale になることも assert する）。
- [ ] 親契約 template の遷移表・差し戻し・エスカレーションの実装と、skill 未配布 host での
      end-to-end 手動検証（§10）。
- [ ] Web: Settings の Workflows 編集ページ。
- [ ] Web: Start workflow ボタン + `terminal/launch` の `"workflow-run"` 拡張。
- [ ] Web: issue / PR detail への run 状態表示（current_step、rework_count、blocked 理由）。
- [ ] エスカレーションの Inbox 連携と run の stop 操作。
- 将来（v1 外）: codex runtime 対応（system prompt channel の調査から）、repo ごとの既定
  workflow、親 orchestration のカスタマイズ、#964 catalog への昇格（§11）。

---

## 14. 決定事項と既知の制限

- **runtime は v1 claude のみ。** codex exec に契約を分離 channel で渡す手段がないため。
  positional prompt への契約連結は「ユーザー prompt と同じ channel に混ざる」ので採らない
  （§7.2 の境界が成立しない）。
- **herdr 前提。** 子の split pane 起動・停滞検知・つつきが herdr の機能に立脚する。herdr の
  無い環境での Workflow run は v1 ではエラー。
- **契約の保証は構造的（channel レベル）。** 意味論レベルの逸脱は、LoopHub 観測可能な完了条件と
  Verify step、親の停滞検知で受け止める（§7.2）。
- **同一 Verify エージェントの継続利用は不採用。** 差し戻し後の再検証も毎回新しい子で行う
  （§8.3）。継続利用には「自分の指摘を自分で閉じる」収束性の利点があるが、fresh な子でも
  過去の verdict（入力 `prior-verdicts.md`、§6.9）を読めば状況は追える — 収束に必要な継続性は
  エージェントの記憶ではなく LoopHub の状態（配置済み artifact）に持たせる。
- **完了を宣言するコマンドは作らない。** `step complete` / `advance` のような状態セット系は
  run row と配置記録の二重真実を生むため設けない（#976 の決定を維持）。`lh workflow step
  output` は成果物（artifact）の提出であって完了宣言ではなく、`lh workflow step status` は
  配置記録と現 head から毎回計算する query である（§6.5、§9.4）。次へ進める判断は親の責務の
  まま残す。
- **完了判定に marker ヒューリスティックを使わない。** PR body の placeholder 置換検知・
  `<!-- workflow:reflect -->` marker 検索は全廃する。判定の入力は正本（`workflow_artifacts`）・配置台帳
  （`workflow_placements`）・現 head だけであり、ドメイン上の表現は placement の出力にすぎない
  （§6.5）。
- **step 構成と artifact 型は列挙で固定。** Plan / Execute / Verify / Reflect の 4 step と
  plan / execution-report / verdict / reflection の 4 型以外を作らない。ユーザー定義 step /
  DAG / ユーザー定義 artifact 型は非目的 — #975 の「汎用 workflow 定義機構は作らない」の継続
  である。ユーザーに見える設定面も増やさない（設定は引き続き step prompt のみ）。
- **子はドメイン識別子を知らない。** 子の世界は「入力 artifact + worktree + `lh workflow step
  output`」に固定する（§6.1）。issue id / PR id / 配置先・取得手段は契約にも入力にも現れず
  （§6.6、§10.1）、ドメインとの境界はエンジン（入力合成と placement policy）が一手に持つ。
  親は例外的にドメイン識別子を知る（エスカレーション等で使う、§8.2）。
- **artifact はドメイン非依存の正本、ドメインへの紐づけは run が所有する。** `workflow_artifacts`
  は run / step / SHA / 内容だけを持ち、issue / PR への参照も配置情報も持たない（§5.2）。
  run（v1 では常に PR に紐づく）が artifact をドメインへ投影し、その台帳（`workflow_placements`）を
  管理する責務を負う（§6.4）。ドメインに触れる箇所は run 開始・入力合成（`inputs.ts`）・配置
  （`placement.ts`）の 3 つに限定し、schema・契約・prompt 合成・完了評価は PR 非依存を保つ。
  これにより、PR を持たない run（配置を伴わない binding）への将来拡張が placement の差し替え
  だけで可能になる — そのユースケースは v1 には無いが、境界として維持する。
- **run の自動 resume なし。** 親の死亡・エスカレーション後は人間が `lh workflow start` を
  再実行する。openPr の冪等性により同じ PR / worktree で続きから始まる。
- **run 中の workflow 編集は次の launch-step から反映**（§5.1）。step 単位のスナップショットは
  持たない。
- **バージョニングなし・global スコープ・4 step 固定**は issue の指定どおり v1 の前提。
- **既存 skill chain は無変更。** Workflow はあくまで並行する実験入口である（§11）。
