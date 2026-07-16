# Execute / Verify workflow — ポインタ入力と HEAD/review 観測による親子協調

> Status: Implemented · Issue: #975 / #981 / #1284 / #1307 / #1358
>
> 本書は、特定の skill を必須とせずに開発 workflow を実行するモデルを定義する。step は
> **Execute / Verify の 2 つに固定**し、ユーザーが設定できるのは各 step に与える prompt だけである。
> #1358 で **artifact 契約と入力合成機構を廃止**し、エージェント間の情報交換を次の 2 原則へ統一した。

- **fact はドメイン状態に書く** — 完了・commits・review などの事実は event / git / DB に記録する。
  エージェント間の直接メッセージ（提出物・artifact）は存在しない。
- **instruction は injection で配達する** — agent への入力は起動プロンプト、または生きている pane
  への注入で届ける。配達はインフラ（worker / engine）の仕事であり、子は親の pane・topology を知らない。

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
| Execute → 親 | ターン完了の宣言（payload なし） | `lh workflow turn done` が event を記録（fact）。worker が tail して親へ配達 |
| 親 → Verify | input: (issue 参照, base SHA, head SHA) の 3 ポインタ | 起動プロンプト。合成ファイルなし |
| Verify → 世界 | pass / request_changes ＋ findings | head SHA に pin された PR review（fact） |
| Verify ↔ Execute | 直接のやりとりなし | diff と review という domain object 経由 |

```text
[Web / CLI]
  人間が確認済みの issue で workflow を開始
            │
            ▼
  workflow agent（親）
    │  turn_done を subscribe し、通知を受けたら step status を観測して遷移する
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
    └─ fresh pass review → run completed（merge は人間）
```

## 3. アクターと責務

### 3.1 workflow agent（親 = 観測とポインタ配達に徹する orchestrator）

1. run 開始時に自 pane を `lh subscribe --event workflow_run.turn_done` で購読する。
2. `lh workflow launch-step` で Execute / Verify child を起動する（engine が input ポインタを解決）。
3. **遷移は「turn done 通知の受領 → `lh workflow step status` で HEAD / review 状態を観測」で決める。**
   宣言はタイミングの合図であり真実を代替しない。宣言があっても HEAD が前進していなければ Verify を
   起動しない。
4. `lh workflow run advance-to-verify | complete | request-rework | await-human | resume | stop` の
   意図ベース command で lifecycle を遷移する。
5. request_changes review に対しては、最新 Execute child を `herdr agent get` で解決し、`pane_id` が
   得られれば `agent_status: done` でも同じ pane へ「review <id> に対応せよ」という instruction の
   注入を先に試す。agent を解決できない、`pane_id` がない、または注入に失敗した場合だけ
   `--review <id>` で fresh relaunch する。findings の要約・解釈は行わず、修正後の Verify は常に
   fresh child とする。
6. 上限超過や解消不能状態を issue comment + Inbox + needs-human 状態で人間へ渡す。
7. passing verdict で run を completed にする。merge はしない。

親は idle 検知を使わない（`herdr agent wait --status idle` を使わない）。親はコード・review・PR を
直接編集しない。

### 3.2 Execute agent（ドメインを知る pull 型開発者）

1. `lh issue view` / `lh pr view` で issue・PR（rework 時は対応すべき review）を自分で読む。
2. 関連コードを見て最小の実装計画を session 内に持つ（独立 artifact として提出しない）。
3. 実装し、repo 標準の test / lint / typecheck を green にする。
4. 結果を **ドメイン状態** に書く: commits、`lh pr update` による PR body、`lh attachment add`、
   `lh pr comment`、draft の場合は `lh pr ready-for-review`。
5. ターン完了を `lh workflow turn done`（payload なし）で宣言する。**commit 前に宣言しても run は
   進まない**（親が HEAD 前進を観測しないため）。

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
Workflow 専用の freshness / dirty / checkpoint 状態は追加しない。

## 6. 完了宣言（turn done）

Execute は `lh workflow turn done`（payload なし）でターン完了を宣言する。engine はこれを
`workflow_run.turn_done` event として記録し、worker の generic event pub/sub（`lh subscribe` +
`notifyForEvent`、#1232）が **その run の親 pane にだけ**（payload の `parent_session_id` で絞り込み、
`pull_request.github_feedback` と同じ仕組み）配達する。子の contract に親の pane id や topology は
現れない。

宣言は真実を代替しない: 親は宣言の受領後に `lh workflow step status` で HEAD / review 状態を観測して
から遷移する。idle 検知は完了推定に一切使わない。

## 7. 親の遷移

| From | 観測条件（step status） | Action |
|---|---|---|
| start | run started | subscribe → Execute を launch |
| Execute | HEAD が base より先行し、最新 review より前進 | `advance-to-verify` → Verify を fresh launch |
| Verify | 最新 review が fresh + pass | `complete` → 停止 |
| Verify | 最新 review が fresh + request_changes | rework → Execute |

rework 上限は 3。最新 Execute child に対する `herdr agent get` が成功して `pane_id` を返す場合は、
`agent_status: done` でも pane は再利用可能と扱い、新規 launch より先に
`orchestrator: address review #<id>` の注入を試す。agent を解決できない、`pane_id` がない、または
注入に失敗した場合に限り `--review <id>` で Execute child を再 launch する。修正後の Verify は常に
fresh child とする。

宣言がないまま run 活動が一定時間停止した場合、worker の stall sweep（`sweepStalledRuns`）が独立して
その run を needs-human に保持し Inbox で人間へ可視化する。自動回復は試みない。rework 上限・escalation・
人間による resume / stop は引き続き機能する。run の status は `running | completed | stopped` のみ
（人間待ちは `running` のまま needs_human_reason を持つ）。

## 8. CLI

```sh
lh workflow create <name> [--execute-prompt <text>] [--verify-prompt <text>]
lh workflow update <name> [--step execute|verify --file <path|->]
lh workflow start <issue> --workflow <name>
lh workflow launch-step --run <id> --step execute|verify [--review <id>] [--note <text|->]
# 親の遷移駆動（意図ベース lifecycle command。7 節の遷移表と対応）
lh workflow run advance-to-verify|complete|request-rework|await-human|resume|stop --run <id>
lh workflow turn done [--run <id>]          # Execute child がターン完了を宣言（payload なし）
lh workflow step input <run> <step>         # 合成した contract + input ポインタ + prompt を dry-run
lh workflow step status <run> --json        # HEAD/base・最新 turn-done・最新 workflow review の freshness を観測
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
| `core/service/workflow-runs.ts` | run start、child launch、turn done、status、rework、stall sweep |
| `core/store/workflows.ts` / `core/serialize.ts` | 2 prompt の persistence / wire shape |
| `cli/commands/workflow.ts` | thin CLI |
| `worker/maintenance.ts` | 宣言なし停滞 run の needs-human 可視化 sweep |
| `web/src/components/workflow-run-status.tsx` | Execute → Verify tracker と最新 review 表示 |

## 11. 検証観点

- 「Execute → turn done → Verify pass」「request_changes → rework 注入（review id 指定）→ turn done →
  fresh Verify pass」「宣言なしタイムアウト → 人間へ可視化」「明示的 stop」の基本フローが artifact
  なしで決定的に完了する。
- Execute input が issue / PR / (rework 時) review id のポインタのみで、`task.md` / `findings.md` が
  生成されない。
- Verify input が (issue 参照, base SHA, head SHA) のみで、`changes.diff` / `report.md` /
  `prior-verdicts.md` が生成されない。
- status は HEAD / base / 最新 review の freshness を返し、head advance で pass が stale になる。
- idle 検知が遷移・完了判定に使われない。
- 旧 artifact テーブルが新しい run の進行条件にならない。
