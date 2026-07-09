# skill 非依存の Plan/Execute/Verify/Reflect 固定 workflow — 設計メモ

> Status: Design（実装は別 issue） · Issue: #975 · PR: #976
> 本書は、skill（`SKILL.md` / slash command）を一切使わずに開発 workflow を実行するモデルを
> 定義する。step は **Plan / Execute / Verify / Reflect の 4 つに固定**し、ユーザーが設定できる
> のは各 step で agent に与える prompt だけである。この 4 step 構成の workflow に名前をつけて
> 複数作成できる。以下この仕組みを **PEVR workflow** と呼ぶ。
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

この設計で決めること:

- 親（workflow agent）の責務 — 起動方法、子エージェントの split pane 起動、step 遷移の判断、
  子への追加指示（つつき方）。
- Plan / Execute / Verify / Reflect 各 step の入力・出力の契約（受け取るもの、完了時に残す
  成果物とその形式、完了条件）。
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
  PEVR workflow は **並ぶもう 1 つの入口**であり、置換ではない。
- workflow のバージョニング（初期バージョンでは不要）。
- Plan / Execute / Verify / Reflect 以外の step 構成のカスタマイズ（汎用 workflow 定義機構は
  作らない）。

---

## 2. 用語

| 用語 | 意味 |
|---|---|
| PEVR workflow | Plan / Execute / Verify / Reflect の 4 step 固定の開発 workflow。名前を持ち、複数作成できる。ユーザーが設定するのは各 step の prompt だけ。 |
| step | Plan / Execute / Verify / Reflect のいずれか。順序・構成は固定で変更できない。 |
| step contract（契約） | step ごとに LoopHub が定義する入出力の取り決め — その step が何を受け取り、何をどんな形式で残せば完了か、何をしてはならないか。LoopHub 同梱（git 管理）で、ユーザーは変更できない。 |
| step prompt | ユーザーが workflow ごと・step ごとに設定する自由記述 prompt。「契約の中でどう働くか」を指定する。空でもよい（契約だけで step は成立する）。 |
| workflow agent（親） | run ごとに 1 つ起動される orchestrator agent。子を起動し、LoopHub の状態を見て step を遷移させる。コードは書かない。 |
| step agent（子） | 各 step を実行する agent。親が herdr の split pane で起動する。 |
| run | ある issue に対する PEVR workflow の 1 回の実行。issue・PR・worktree・親 session に紐づく。 |
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
  positional / stdin のみ）。→ v1 の PEVR workflow は **claude runtime のみ**対応（§14）。
- **herdr** は次を提供する:
  - `herdr agent start <name> --cwd PATH [--tab ID] [--split right|down] -- <argv...>` —
    既存 tab 内への **split pane での agent 起動**。
  - `herdr agent wait <target> --status <idle|working|blocked|unknown> [--timeout MS]` —
    子の稼働状態の待機（停滞検知に使う）。
  - `herdr pane run <pane_id> <command>` — pane への command text + Enter の注入（つつき）。
  - `herdr agent read <target>` — pane 出力の読取（デバッグ・停滞診断の補助）。
- **親の遷移判断に使える LoopHub 側の情報**: `lh pr view --json` は `draft` / `head` /
  `review_state` / `comments` / `mergeable` / `changes_addressed_at` を返す。`lh issue view
  --json` は body / comments を返す。`lh events -f --repo <r>` で SSE の event feed を tail
  できる。`lh handoff record / list` で親子間の受け渡しを PR に紐づけて記録できる。

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
   workflow agent（親） … 遷移判断は LoopHub の状態のみで行う
     ├─ lh workflow launch-step --run <id> --step plan     → 子 pane（split）
     │     Plan: PR body の実装計画 section を書く
     ├─ （plan 完了を lh pr view --json で確認）
     ├─ lh workflow launch-step --run <id> --step execute  → 子 pane（split）
     │     Execute: commit、PR body 完成、draft→ready
     ├─ （ready + commits を確認）
     ├─ lh workflow launch-step --run <id> --step verify   → 子 pane（split）
     │     Verify: lh pr review（--event pass / request_changes）
     ├─ request_changes → Execute へ差し戻し（つつき or 再起動）→ 再 Verify（上限あり）
     ├─ pass → lh workflow launch-step --run <id> --step reflect
     │     Reflect: 構造化 reflection comment を PR に投稿
     └─ run 完了（merge はしない — 人間が行う）
```

子の**起動タイミングの判断は親**が行い、**起動される prompt の合成は LoopHub**（`lh workflow
launch-step`）が行う。この分担が「契約はユーザー prompt でも親の裁量でも壊せない」を支える
（§7）。

---

## 5. workflow の定義・保存・編集

### 5.1 保存場所と形式

PEVR workflow は **LoopHub DB に保存する**。git にも skill にも置かない。

```sql
CREATE TABLE pevr_workflows (
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
  を既に認めており、PEVR の step prompt は**この inline 例外の第 2 のケース**である（§11）。
- スコープは v1 では **global**（repo をまたいで共有）。repo ごとの既定 workflow の指定などは
  必要になってから後続 issue で設計する。
- バージョニングはしない。update は上書き。run 実行中に workflow を編集した場合、合成は
  `launch-step` 時点の DB 値で行われるため、**次に起動される step から**反映される（§14）。

### 5.2 run の追跡

```sql
CREATE TABLE pevr_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id        INTEGER NOT NULL REFERENCES pevr_workflows(id),
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

run row は UI 表示（この issue はいまどの step か）と、親の状態報告（`lh workflow run update`）
の置き場である。**遷移の真実は PR / review の状態**（§8）であり、run row はその写しにすぎない —
親が死んで run row が古くなっても、PR の状態から人間が判断できる。

### 5.3 編集方法

| 経路 | 内容 |
|---|---|
| Web UI | Settings に「Workflows」ページを追加。一覧 + 編集フォーム（name / description / 4 step の textarea）。保存時 validation（name 非空・unique）は `422` + form error。 |
| JSON-RPC | `pevrWorkflows/list` / `get` / `create` / `update` / `delete`。wire shape は `core/serialize.ts` に置き、`web/src/api/types.ts` は型を再宣言しない（既存規約どおり）。 |
| CLI | `lh workflow list` / `view <name>` / `create <name>` / `update <name> [--step plan --file <path|->]` / `delete <name>`。 |

新規作成フォームは、core 定数として持つ**例文 prompt** を prefill する（DB に seed row は
作らない）。実行中の run から参照されている workflow の delete は拒否する。

---

## 6. step 契約

契約は step ごとに固定の markdown template として **LoopHub repo（git）の
`core/pevr/contracts/<step>.md`** に置く。ユーザーは編集できない（変更は LoopHub 本体への PR）。
各契約は次の 4 部で構成する: **入力（何を受け取るか / どこから読むか）・成果物（何をどんな
形式で残すか）・完了条件（LoopHub 上で観測可能なもの）・禁止事項**。

完了条件はすべて「**LoopHub の API で観測できる状態**」で定義する。子の自己申告（pane 出力の
「done」等）を完了の根拠にしない — これが親の遷移判断を herdr 非依存にする（§8）。

### 6.1 Plan

| 項目 | 内容 |
|---|---|
| 入力 | issue の body + 全 comments（`lh issue view <n> --json`）、worktree のコード（読取）、run context（repo / issue / PR 番号、worktree path）。 |
| 成果物 | **linked PR body の実装計画 section** を placeholder から実文に置換する（`lh pr update`）。内容: 変更予定ファイル / 領域、再利用する既存 API・module、スコープ境界、検証方法。markdown。 |
| 完了条件 | PR body の実装計画 section が placeholder でなく非空（親は `lh pr view --json` の `body` で判定）。 |
| 禁止事項 | source の編集・commit。PR body の実装計画 section 以外の書き換え。issue / PR の state 変更。 |

### 6.2 Execute

| 項目 | 内容 |
|---|---|
| 入力 | PR body の実装計画、issue の body + comments、worktree。**差し戻し時は追加で**: 現 head への review findings（`lh pr view --json` の review / comments）と親からの note（§8.3）。 |
| 成果物 | (1) head branch への commits（テスト green。repo 標準のテスト・lint・typecheck を実行し結果を記録する）。(2) PR body の完成 — Summary / Acceptance criteria / Test plan / Evidence（issue の AC をチェックリストとして写し、満たした項目だけ check）。(3) `lh pr ready-for-review <m>` で draft → ready。 |
| 完了条件 | PR が `draft: false` で、head が base より先行している（親は `lh pr view --json` の `draft` / `head` / `changed_files` で判定）。差し戻し後は「review 時点より新しい head + ready 状態」。 |
| 禁止事項 | merge。base branch・worktree 外の編集。issue の close。Verify の代行（自分の変更に `lh pr review` を出さない）。 |

### 6.3 Verify

| 項目 | 内容 |
|---|---|
| 入力 | PR diff（`lh pr diff`）、issue の AC、PR body の Evidence、この PR の既存 review・指摘コメント（あれば — 差し戻し後の再検証では前回指摘の解消確認に使う）、worktree（読取。テストの再実行は可）。 |
| 成果物 | 現 head に対する `lh pr review <m> --event pass` または `--event request_changes`。指摘は具体的に: file:line、問題、期待する状態。実装者の主張（Evidence）を鵜呑みにせず自分で検証する。 |
| 完了条件 | 現 head SHA に対する review が提出されている（親は `review_state` と head の対応で判定）。 |
| 禁止事項 | source の編集（読取専用 — 見つけた問題を自分で直さない。独立性を保つ）。merge。PR body の書き換え。 |

### 6.4 Reflect

| 項目 | 内容 |
|---|---|
| 入力 | run の全経過 — issue、PR（body・全 review・comments）、rework 回数、handoff 記録（`lh handoff list --pr <m>`）。 |
| 成果物 | PR への**構造化 reflection comment**（`lh pr comment`）。先頭に marker `<!-- pevr:reflect -->` を含み、次の節を持つ: うまくいったこと / 詰まったこと・差し戻しの原因 / step prompt・契約への改善提案 / 後続 issue 候補。 |
| 完了条件 | marker 付き comment が PR に存在する（親は `lh pr view --json` の `comments` で判定）。 |
| 禁止事項 | source の編集。issue / PR の state 変更。merge。 |

### 6.5 全 step 共通の契約条項

- 作業は run の worktree 内で行う。`lh` の呼び出しには `--repo <owner>/<name>` を付ける。
- slash command（`/lh-*` 等）を呼ばない。skill に依存せず、この契約と step prompt だけで働く。
- 完了条件を満たしたら短く結果を報告して停止する（次の作業を自分で始めない — 次 step の起動は
  親の責務）。
- step prompt は「この契約の範囲内でのカスタマイズ」である。**step prompt と契約が矛盾する
  場合、契約が優先する**（この一文自体を契約 template に含める）。

---

## 7. 契約の合成と挿入機構

### 7.1 channel の分離

子 agent の起動 argv は **LoopHub（`lh workflow launch-step`）だけが合成する**。契約と
ユーザー prompt は別 channel で渡す:

```sh
claude \
  --session-id <uuid> \
  --append-system-prompt-file "$LOOPHUB_HOME/runs/pevr/<run-id>/<step>-contract.md" \
  [--permission-mode auto] \
  "<composed user prompt>"
```

- **契約** = `core/pevr/contracts/<step>.md`（固定 template）に run context（repo / issue / PR
  番号、worktree path、base branch）を埋めたもの。launch 時に run ディレクトリへ書き出し、
  `--append-system-prompt-file` で **system prompt に追加**する。
- **user prompt**（positional）は LoopHub が次の形に合成する:

  ```text
  ## Run context
  repo: <owner>/<name> / issue: #<n> / PR: #<m> / step: <step>

  ## Step prompt (user-configured)
  <DB の <step>_prompt。空なら「(none — follow the contract)」>

  ## Note from the workflow agent
  <親が --note で渡した追加指示。差し戻し理由など。無ければ省略>
  ```

### 7.2 上書き・省略できない境界

ユーザーが触れる入力は「DB の step prompt」と「issue / PR の本文」だけで、いずれも
**positional user prompt の中の 1 section にしか埋め込まれない**。契約側の channel
（`--append-system-prompt-file` の内容）に至る経路にユーザー入力は存在しない:

- 契約 template は git 管理の LoopHub 同梱ファイル。DB・設定・step prompt から内容を差し込む
  変数は run context の識別子（repo 名、番号、path）だけ。
- argv の合成は `lh workflow launch-step` の中で行われ、親にも文字列を渡さない（親は run id と
  step 名と note を指定するだけ）。親の裁量でも契約を外せない。
- step prompt に何を書いても、system prompt の契約は必ず存在する。

この保証は **channel レベル（構造的）** のものである。「モデルが契約に従うか」という意味論
レベルの保証ではない — step prompt に契約へ背く指示を書けば、モデルが混乱することはあり得る。
それは §6.5 の優先順位条項（契約 > step prompt）と、**完了条件が LoopHub 上の観測で定義されて
いる**こと（背いた場合は完了条件を満たせず、親が停滞として検知する）で受け止める。

### 7.3 親への挿入

親も同じ機構で起動する: 親契約 `core/pevr/contracts/parent.md`（責務・遷移表・使ってよい
コマンド）を `--append-system-prompt-file` で挿入し、positional prompt には run context だけを
渡す。**親にはユーザー設定 prompt がない**（v1）。orchestration の挙動をユーザーが変えたく
なった場合は、それが本当に必要かを含めて後続 issue で扱う。

---

## 8. 親（workflow agent）の責務と遷移判断

### 8.1 責務

1. **run 状態の報告** — step 遷移のたびに `lh workflow run update --run <id> --step <step>`
   で run row を更新する（UI 表示用。真実は PR 状態であり run row はその写し、§5.2）。
2. **子の起動** — `lh workflow launch-step --run <id> --step <step> [--note <text|->]`。
   herdr の split pane（`agent start --tab <run tab> --split down`）で run の worktree を cwd に
   起動される。合成は LoopHub、タイミングと note の判断は親。
3. **遷移判断** — §8.2 の表に従い、**LoopHub の状態だけ**を根拠に次 step へ進む。
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
| PR body | `lh pr view <m> --json` の `body` | 実装計画 section が実文になった → **Plan 完了、Execute へ** |
| draft flag / head / changed_files | 同上 | `draft: false` かつ head が base より先行 → **Execute 完了、Verify へ** |
| review_state と head の対応 | 同上（`review_state`、`head`） | 現 head への pass review → **Verify 完了、Reflect へ**。request_changes → **差し戻し（§8.3）** |
| comments | 同上（`comments`） | `<!-- pevr:reflect -->` marker 付き comment → **Reflect 完了、run 完了** |
| event feed | `lh events -f --repo <r>`（SSE tail） | `pull_request.updated` / review 系 event を polling の代わりの起床トリガーに使う（polling fallback 併用） |
| issue の状態 | `lh issue view <n> --json` | issue が close された等の外部変化 → run を `stopped` にして終了 |
| 受け渡し記録 | `lh handoff list --pr <m>` | Reflect の入力素材（遷移判断には使わない） |

`launch-step` は起動時に `lh handoff record --phase <step> --dir down` で「親→子に何を渡したか」
を記録する。子の成果物は PR 上に残るので `--dir up` の明示記録は必須にしない。

上表の完了条件の評価は、親が生の JSON を解釈するのではなく、core の pure な評価関数（§12）に
実装して `lh workflow step status` として公開する（§9.4）。真実は引き続き PR / issue の状態で
あり、status は呼ばれるたびにそこから計算される **query** である。これにより親の遷移判断は
「status を取得し、表に従って行動する」に縮み、判定ロジック自体はエージェントなしで unit test
できる。

### 8.3 差し戻し（request_changes → Execute）

1. `rework_count` を +1（`lh workflow run update`）。上限（v1 は 3 回固定）超過なら §8.4 へ。
2. Execute の子 pane がまだ生きていれば（`herdr agent get`）、`herdr pane run` で review
   findings への対応を指示する — session の文脈を保てるので優先する。
3. pane が閉じていれば `lh workflow launch-step --step execute --note <findings 要約>` で
   再起動する。契約の差し戻し時入力（§6.2）が review findings を読むことを保証する。
4. Execute が新 head + ready にしたら、**Verify を新しい子として再起動**する。同じ reviewer
   session は使い回さず、常に新規起動する（§14 の決定。前回指摘の解消確認は、fresh な子が
   §6.3 の入力として既存 review を読むことで行う）。

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
- Start workflow はドロップダウンで **保存済み PEVR workflow を名前で選んで起動**する
  （`pevrWorkflows/list` を表示。0 件なら Settings の Workflows ページへの導線を出す）。
- 表示条件は Build と同じ判定を使う: linked open PR が既にある issue では Build 同様に起動系
  ボタンを出さない（1 issue につき同時 1 系統。Build と PEVR run は同じ soft guard —
  「open PR は同時に 1 つ」— を共有する）。

### 9.2 RPC

`terminal/launch` の `workflow` enum に `"pevr-run"` を追加し、params に `pevrWorkflowId` を
足す。server 側（`core/service/terminal.ts`）は `launchIssueDevHerdr` と同型の
`launchPevrRunHerdr` で `lh workflow start <owner>/<repo>/<n> --workflow-id <id> --herdr` を
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

step の interface は「入力（LoopHub が合成する契約 + prompt）」と「出力（LoopHub 上の成果物）」
だけである。これを `lh workflow` の query として公開する:

```sh
lh workflow step input <run> <step> [--note <text|->]   # 合成される入力を表示する dry-run（起動しない）
lh workflow step status <run> [--json]                  # 各 step の完了条件の評価結果（満たされた / 欠けているもの）
```

- `step input` は `launch-step` と同一の合成を行い、契約（system prompt 側）と user prompt を
  表示だけする。channel 分離の unit test（ユーザー入力が契約 channel に混入しない、§13）は
  合成の実体である `core/pevr/compose.ts` を直接 assert する。`step input` は同じ合成結果を
  人間の確認とエージェントなし e2e（§13）に使うための窓である。
- `step status` は **query であって actuator ではない**。完了を宣言する `step complete` や、
  status に基づいて次 step を自動起動する `advance` は作らない（§14）。完了は常に成果物から
  計算し、進める判断は親に残す。

この 2 つと既存の `lh` コマンドだけで、**エージェントを 1 つも起動せずに run を最初から最後まで
動かせる**。成果物を人間（またはテスト）が作れば、workflow はそれを完了として観測する — step の
実行主体が agent / 人間 / テストスクリプトのどれであっても、interface は同じである。

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
（core/pevr/contracts/plan.md に run context を埋めたもの）
--- user prompt ---
## Run context
repo: jugyo/loophub / issue: #42 / PR: #43 / step: plan
## Step prompt (user-configured)
(none — follow the contract)

# 3) 完了条件を確認 — まだ何も満たされていない
$ lh workflow step status 7 --json
{ "run": 7,
  "steps": {
    "plan":    { "complete": false, "missing": ["PR body implementation-plan section is still the placeholder"] },
    "execute": { "complete": false, "missing": ["PR is draft", "head equals base"] },
    "verify":  { "complete": false, "missing": ["no review for current head"] },
    "reflect": { "complete": false, "missing": ["no pevr:reflect comment"] } } }

# 4) Plan の成果物をエージェントの代わりに手で作る
$ lh pr update 43 --repo jugyo/loophub --body "$(cat body-with-plan.md)"
$ lh workflow step status 7 --json | jq .steps.plan.complete
true

# 5) Execute の成果物: commit して ready にする
$ git -C ~/.loophub/worktrees/jugyo/loophub/pr-43 commit --allow-empty -m "impl"
$ lh pr ready-for-review 43 --repo jugyo/loophub
$ lh workflow step status 7 --json | jq .steps.execute.complete
true

# 6) Verify の成果物: 現 head へ review を投稿
$ lh pr review 43 --repo jugyo/loophub --event pass --body "ok"

# 7) Reflect の成果物: marker 付きコメント
$ lh pr comment 43 --repo jugyo/loophub --body "<!-- pevr:reflect --> ..."
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
execute  incomplete — PR is draft
verify   incomplete — no review for current head
reflect  incomplete — no pevr:reflect comment
```

---

## 10. skill 非依存の確認

入口から子まで、各ホップで agent に渡る prompt の出所を列挙する:

| ホップ | prompt / 指示の出所 | skill / slash 依存 |
|---|---|---|
| Start workflow ボタン → `terminal/launch` | 構造化パラメータのみ（prompt なし） | なし |
| RPC handler → `lh workflow start` spawn | argv のみ | なし |
| `lh workflow start` → 親起動 | 親契約 = `core/pevr/contracts/parent.md`（git 同梱）+ run context | なし |
| 親 → `lh workflow launch-step` → 子起動 | step 契約 = `core/pevr/contracts/<step>.md`（git 同梱）、step prompt = DB（`pevr_workflows`）、note = 親の自由記述 | なし |
| 子 → LoopHub | `lh` CLI の呼び出しのみ | なし |

- 合成されるどの prompt にも slash command 呼び出しを含めない。契約 template に「slash
  command を呼ばない」を明記する（§6.5）。
- `SKILL.md` を読む箇所、`~/.claude/skills` / `npx skills add` の配布状態に依存する箇所が
  経路上に存在しない。skill が 1 つもインストールされていない host でも PEVR workflow は
  動作する。
- 実装時の検証: 合成 prompt（契約 + user prompt）に `/lh-` パターンが含まれないことの unit
  test、および skill を配布していない環境での end-to-end 手動確認をチェックリストに含める
  （§13）。

なお「skill 非依存」は「agent host 非依存」ではない — claude CLI と herdr は前提である。

---

## 11. #964（workflow instruction 管理モデル）との関係

`docs/workflow-instruction-model.ja.md`（#964 / PR #966）は、既存の skill ベースの入口を
workflow / step / instruction binding として宣言化し、binding の差し替えを 4 層設定で管理する
モデルを定義した。本書との関係は **置換でも統合でもなく、併存する実験**である。

| 観点 | #964 モデル | 本書（PEVR） |
|---|---|---|
| instruction の実体 | skill（`SKILL.md`、git + `npx skills add` 配布） | LoopHub 同梱契約（git）+ inline step prompt（DB） |
| step の実行形態 | entry step の launch + 本文内 chain（`execution: "chained"`） | すべて親が起動を仲介する launch |
| ユーザーの自由度 | binding（どの instruction を使うか）の差し替え | 契約内での step prompt の記述 |
| 手順の骨格の所有者 | skill 本文（chain は本文に埋まる） | LoopHub（契約と親） |

明文化する取り決め:

- **併存（実験扱い）。** 既存 skill chain は変更せず、Build ボタンの隣に PEVR の入口が増える
  だけである。#964 の catalog（`loophub@1`）にも PEVR workflow は **v1 では登録しない** —
  catalog は immutable versioned であり、実験段階の PEVR を載せると変更のたびに catalog
  version が要る。同様に #964 の `WorkflowConfig`（binding override）の対象にもならない。
- **#964 の語彙との整合。** #964 の用語で言えば、PEVR run は「すべての step が
  `execution: "launch"` で、instruction の delivery が skill ではなく inline な entrypoint
  workflow」である。#966 §8 は将来の delivery 拡張（`kind: "prompt"` 等の tagged union）を
  予約しており、PEVR の step prompt はその具体例になる。また #966 §4.3 は「将来 LoopHub が
  step 起動を仲介するモデル」への移行を展望しており、**PEVR の親仲介 launch はその実証実験を
  兼ねる**。
- **昇格の条件。** 実験が定着したら、後続 issue で (1) catalog の新 version に PEVR 系
  workflow を登録し、(2) instruction delivery に inline 種別を追加し、(3) 4 step 固定の緩和や
  binding との統合を必要に応じて設計する。定着しなければ、DB テーブルと UI・CLI を落とすだけで
  skill / catalog 世界には何も影響しない — これが「実験扱い」の設計上の意味である。
- **用語の衝突回避。** 「workflow」という語は 3 つある: #964 の workflow（宣言化された作業
  単位）、repo automation（`.loophub/workflow.yml`）、本書の PEVR workflow。ドキュメント・UI
  では PEVR workflow を単に「Workflow」と表示してよいが、設計文書では PEVR workflow と
  呼び分ける。

---

## 12. 実装境界

後続 issue で実装する場合の責務分担:

| 層 | 責務 |
|---|---|
| `core/pevr/contracts/*.md`（新規） | 親・4 step の契約 template（git 管理）。 |
| `core/pevr/compose.ts`（新規） | 契約 + run context + step prompt + note の pure な合成。DB / fs を読まない。 |
| `core/pevr/steps.ts`（新規） | step 完了条件の pure な評価（serialize 済みの PR / issue 状態 → complete / missing）。DB / fs を読まない。 |
| `core/db.ts` / `core/store/pevr.ts`（新規） | `pevr_workflows` / `pevr_runs` の schema・migration・CRUD。 |
| `core/service/pevr.ts`（新規） | workflow CRUD（validation、`422`）、run 開始（`dev.openPr` / worktree provision / dev lock の再利用）、launch-step の合成と herdr 起動、run update。 |
| `core/terminal/terminal-launch.ts` | split pane 起動 argv（`--split` 対応の builder 追加）。既存 builder の流儀に従う。 |
| `cli/commands/workflow.ts`（新規） | `lh workflow start / launch-step / step input / step status / run update / list / view / create / update / delete`。thin に保ち、判断は service へ。 |
| `web/server/contract.ts` / `core/service/terminal.ts` | `terminal/launch` の `"pevr-run"` 拡張、`pevrWorkflows/*` RPC。 |
| `core/serialize.ts` | workflow / run の wire shape（`web/src/api/types.ts` は型再宣言しない）。 |
| `web/src/components/issue-detail.tsx` ほか | Start workflow ボタン（dropdown）、run 状態表示。 |
| `web/src/routes/settings` 配下 | Workflows 編集ページ。 |

---

## 13. 後続 issue 向けチェックリスト

上から順に依存が薄い:

- [ ] `pevr_workflows` の schema / store / service CRUD + `lh workflow list/view/create/update/delete`
      + `pevrWorkflows/*` RPC（UI なしで CRUD が成立する縦切り）。
- [ ] `core/pevr/contracts/*.md`（親 + 4 step）と `core/pevr/compose.ts`。合成の unit test:
      契約が必ず system prompt 側 channel に載る / ユーザー入力が契約 channel に混入しない /
      合成 prompt に slash command を含まない。
- [ ] `pevr_runs` + `lh workflow start`（openPr・worktree・lock 再利用、親の herdr 起動）。
- [ ] `lh workflow launch-step`（split pane 起動、handoff 記録、session 登録）+ `lh workflow
      run update`。
- [ ] `lh workflow step input` / `step status`（`core/pevr/steps.ts` の完了条件評価 + 合成 dry-run、
      §9.4）と、エージェントなしで 4 step を通す e2e テスト（成果物を `lh` コマンドで人工的に
      作り、status の complete / missing を assert する）。
- [ ] 親契約 template の遷移表・差し戻し・エスカレーションの実装と、skill 未配布 host での
      end-to-end 手動検証（§10）。
- [ ] Web: Settings の Workflows 編集ページ。
- [ ] Web: Start workflow ボタン + `terminal/launch` の `"pevr-run"` 拡張。
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
  無い環境での PEVR run は v1 ではエラー。
- **契約の保証は構造的（channel レベル）。** 意味論レベルの逸脱は、LoopHub 観測可能な完了条件と
  Verify step、親の停滞検知で受け止める（§7.2）。
- **同一 Verify エージェントの継続利用は不採用。** 差し戻し後の再検証も毎回新しい子で行う
  （§8.3）。継続利用には「自分の指摘を自分で閉じる」収束性の利点があるが、fresh な子でも
  PR 上の既存 review を入力として読めば状況は追える（§6.3）— 収束に必要な継続性は
  エージェントの記憶ではなく LoopHub の状態に持たせる。
- **完了を宣言するコマンドは作らない。** `step complete` / `advance` のような状態セット系は
  run row と PR 状態の二重真実を生むため設けない。`lh workflow step status` は成果物から毎回
  計算する query であり（§9.4）、次へ進める判断は親の責務のまま残す。
- **run の自動 resume なし。** 親の死亡・エスカレーション後は人間が `lh workflow start` を
  再実行する。openPr の冪等性により同じ PR / worktree で続きから始まる。
- **run 中の workflow 編集は次の launch-step から反映**（§5.1）。step 単位のスナップショットは
  持たない。
- **バージョニングなし・global スコープ・4 step 固定**は issue の指定どおり v1 の前提。
- **既存 skill chain は無変更。** PEVR はあくまで並行する実験入口である（§11）。
