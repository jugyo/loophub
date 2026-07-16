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
| 世界 → 親 | turn done、workflow review 登録、GitHub PR feedback の観測通知 | worker が親 pane へ配達する timing signal。親は通知後に domain state を再観測 |
| Verify ↔ Execute | 直接のやりとりなし | diff と review という domain object 経由 |

```text
[Web / CLI]
  人間が確認済みの issue で workflow を開始
            │
            ▼
  workflow agent（親）
    │  turn_done / review_submitted / github_feedback を subscribe
    │  通知を受けたら domain state を再観測して遷移する
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
    └─ fresh pass review → run は running のまま親の観測ループを維持
         ├─ 追加指示 → Execute pane へ注入（閉じていれば --note 付き launch）
         ├─ turn done ＋ HEAD 前進 → fresh Verify
         ├─ turn done ＋ HEAD 不変 → pass は fresh のまま待機
         └─ 明示的 stop → run を恒久終了（merge は人間）
```

## 3. アクターと責務

### 3.1 workflow agent（親 = 観測とポインタ配達に徹する orchestrator）

1. run 開始時に自 pane を `lh subscribe` で `workflow_run.turn_done`、
   `workflow_run.review_submitted`、`workflow_run.github_event` の 3 event に購読する。どの通知も
   domain state の再観測を促す timing signal であり、完了や verdict そのものではない。
2. `lh workflow launch-step` で Execute / Verify child を起動する（engine が input ポインタを解決）。
3. **遷移は「turn done 通知の受領 → `lh workflow step status` で HEAD / review 状態を観測」で決める。**
   宣言はタイミングの合図であり真実を代替しない。宣言があっても HEAD が前進していなければ Verify を
   起動しない。
4. `lh workflow run advance-to-verify | request-rework | await-human | resume | stop` の意図ベース
   command で通常の lifecycle を遷移する。`complete` command の実装は残るが、通常フローの親契約は
   fresh pass を完了扱いせず使用しない。
5. request_changes review に対しては、最新 Execute child を `herdr agent get` で解決し、`pane_id` が
   得られれば `agent_status: done` でも同じ pane へ「review <id> に対応せよ」という instruction の
   注入を先に試す。agent を解決できない、`pane_id` がない、または注入に失敗した場合だけ
   `--review <id>` で fresh relaunch する。findings の要約・解釈は行わず、修正後の Verify は常に
   fresh child とする。
6. 上限超過や解消不能状態を issue comment + Inbox + needs-human 状態で人間へ渡す。
7. passing verdict 後も run と観測ループ、および可能なら Execute pane を維持し、追加指示、turn-done、
   明示的 stop を待つ。run を恒久終了するのは明示的な `lh workflow run stop` だけである。merge はしない。

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
される。worker の generic event pub/sub（`lh subscribe` + `notifyForEvent`、#1232）はこれらを親 pane へ
配達する。run-scoped event は payload の `parent_session_id` でその run の親に絞り込む。子の contract に
親の pane id や topology は現れない。

4 種類の通知はいずれも真実を代替しない timing signal である。親は通知後に
`lh workflow step status`、PR review、または参照された GitHub API resource から domain state を再観測して
判断する。review の verdict や feedback 本文を通知 payload の複製で判断しない。idle 検知は完了推定に
一切使わない。

## 7. 親の遷移

| From | 観測条件（step status） | Action |
|---|---|---|
| start | run started | subscribe → Execute を launch |
| Execute | HEAD が base より先行し、最新 review より前進 | `advance-to-verify` → Verify を fresh launch |
| Execute | `workflow_run.escalated` を受領 | event の reason を再取得し、`await-human` で hold |
| Human wait | Execute の turn done 後、HEAD が最新 review より前進 | `resume --step execute` → 通常の Execute 完了遷移 → fresh Verify |
| Human wait | Execute の turn done 後、HEAD が不変 | hold を維持し、追加作業または明示的 resume / stop を待つ |
| Verify | 最新 review が fresh + pass | run を `running` のまま維持し、追加指示・turn-done・明示的 stop を待つ |
| Verified + continuing | 人間が追加作業を指示 | `run resume` は使わず、既存 Execute pane へ注入する。pane が閉じていれば `--note` 付きで Execute を launch |
| Verified + continuing | Execute の turn done 後、HEAD が passing review より前進 | run は Verify のまま、現在の HEAD に対する Verify を fresh launch |
| Verified + continuing | Execute の turn done 後、HEAD が不変 | 既存 pass は fresh のまま。Verify を起動せず待機を続ける |
| Verify | 最新 review が fresh + request_changes | rework → Execute |

fresh pass は現在の HEAD を検証するが、run を完了・凍結しない。親の観測ループと Execute pane を維持し、
同じ run で追加作業を受け付ける。追加指示時に run は人間待ち hold ではないため `run resume` を使わない。
生きている Execute pane へ `orchestrator: <instruction>` を注入し、pane が閉じている場合は
`lh workflow launch-step --step execute --note <instruction>` で起動する。その後の turn done で HEAD が
進んでいれば fresh Verify を起動し、PR body・comment・attachment だけが変わって HEAD が不変なら既存
pass を fresh のまま維持する。恒久終了は明示的な `lh workflow run stop` で行う。

rework 上限は 3。最新 Execute child に対する `herdr agent get` が成功して `pane_id` を返す場合は、
`agent_status: done` でも pane は再利用可能と扱い、新規 launch より先に
`orchestrator: address review #<id>` の注入を試す。agent を解決できない、`pane_id` がない、または
注入に失敗した場合に限り `--review <id>` で Execute child を再 launch する。修正後の Verify は常に
fresh child とする。

宣言がないまま run 活動が一定時間停止した場合、worker の stall sweep（`sweepStalledRuns`）が独立して
その run を needs-human に保持し Inbox で人間へ可視化する。自動回復は試みない。rework 上限・escalation・
人間による resume / stop は引き続き機能する。run の status は `running | completed | stopped` のみ
（人間待ちは `running` のまま needs_human_reason を持つ）。

`lh workflow run complete` と `completed` status の実装可能性は互換性のため残る。ただし現在の親契約は
通常の fresh pass 後に `complete` を呼ばず、run を `running` のまま保つ。`resume` は `await-human` による
明示的 hold を人間の指示で解除する command であり、fresh pass 後の追加作業には使わない。

## 8. CLI

```sh
lh workflow create <name> [--execute-prompt <text>] [--verify-prompt <text>]
lh workflow update <name> [--step execute|verify --file <path|->]
lh workflow start <issue> --workflow <name>
lh workflow launch-step --run <id> --step execute|verify [--review <id>] [--note <text|->]
# lifecycle command。complete は実装上利用可能だが、現在の親の通常フローでは使わない
lh workflow run advance-to-verify|complete|request-rework|await-human|resume|stop --run <id>
lh workflow turn done [--run <id>]          # Execute child がターン完了を宣言（payload なし）
lh workflow escalate --reason <text> [--run <id>] # Execute child が人間の判断の必要性を宣言
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

- 「Execute → turn done → Verify pass → running のまま追加指示を待機」「追加指示 → Execute 注入または
  `--note` 付き launch → HEAD 前進時だけ fresh Verify」「request_changes → rework 注入（review id 指定）
  → turn done → fresh Verify pass」「宣言なしタイムアウト → 人間へ可視化」「明示的 stop」の基本フローが
  artifact なしで決定的に進行する。
- Execute input が issue / PR / (rework 時) review id のポインタのみで、`task.md` / `findings.md` が
  生成されない。
- Verify input が (issue 参照, base SHA, head SHA) のみで、`changes.diff` / `report.md` /
  `prior-verdicts.md` が生成されない。
- status は HEAD / base / 最新 review の freshness を返し、head advance で pass が stale になる。
- PR body・comment・attachment だけの更新では pass が fresh のまま維持される。
- 親は turn done、review submitted、GitHub feedback の通知を timing signal として購読し、その都度 domain
  state を再観測する。
- idle 検知が遷移・完了判定に使われない。
- 旧 artifact テーブルが新しい run の進行条件にならない。
