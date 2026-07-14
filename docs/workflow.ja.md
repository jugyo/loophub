# skill を前提としない Execute / Verify 固定 workflow — 設計メモ

> Status: Implemented · Issue: #975 / #981 / #1284 / #1307
>
> 本書は、特定の skill（`SKILL.md` / slash command）を必須とせずに開発 workflow を実行する
> モデルを定義する。契約内で任意の skill やレビュー手法を補助利用することは妨げない。workflow の
> step は **Execute / Verify の 2 つに固定**し、ユーザーが設定できるのは各 step に与える prompt
> だけである。

---

## 1. 目的と前提

LoopHub が手順の骨格、step contract、artifact の検証・配置を所有し、ユーザーは contract の
範囲内で各 step の働き方だけを prompt で設定する。

workflow を起動する前提は次のとおりである。

- **人間が issue の title / body / comments を確認し、実装に必要な背景、done 条件、acceptance
  criteria、scope が十分に書かれていると判断してから起動する。** 要求の整理や仕様化を独立した
  Plan agent に委ねない。
- Execute agent は最初に issue と関連コードを読み、自分で実装計画を作る。計画が同じ session
  にあるため、人間は実行中の pane へ介入して計画を確認・変更できる。
- Execute agent は計画、実装、テスト、evidence の収集に加えて、提出前の振り返りも行う。
- Verify agent は Execute とは別 session で、特定 SHA の変更を独立検証する。
- workflow agent（親）は残す。親はコードを書かず、子の起動、step status に基づく遷移、
  rework、停滞時の人間への escalation を担当する。

この設計で扱わないもの:

- Verify step の責務や独立性の変更。
- ユーザー定義 step、任意順序、DAG などの汎用 customization。
- 旧 Plan / Execute / Verify / Reflect 定義、実行中 run、保存済み artifact の移行や後方互換性。
- 既存 skill chain（`lh build` → review → merge-ready）の置換。

## 2. 全体像

```text
[Web / CLI]
  人間が確認済みの issue で workflow を開始
            │
            ▼
  workflow agent（親）
    │
    ├─ Execute child を起動
    │    入力: task.md、差し戻し時は findings.md
    │    責務: 計画 → 実装 → テスト/evidence → 振り返り
    │    出力: commits + execution-report
    │
    ├─ Verify child を新規起動
    │    入力: task.md、changes.diff、report.md、過去 verdict
    │    出力: verdict（pass / request_changes）
    │
    ├─ request_changes → Execute へ戻す → fresh Verify
    └─ pass → run completed（merge は人間）
```

step は次の interface を持つ。

```text
step = f(入力 artifact, worktree) → (出力 artifact, commits)
```

子は issue / PR の取得・更新方法を知らない。LoopHub engine が domain state から入力ファイルを
合成し、`lh workflow step output` で受け取った JSON を検証して PR へ配置する。

## 3. アクターと責務

### 3.1 人間

- workflow 起動前に issue が実装可能な品質か確認する。
- Execute pane へ介入して、agent が持つ計画や進め方を必要に応じて変更する。
- escalation を解消し、最終的な merge を行う。

独立 Plan step を廃止するため、曖昧な issue を workflow 内で仕様化してから実装する動作は保証
しない。要求が不足していれば、親は停滞として扱い人間へ返す。

### 3.2 workflow agent（親）

親は run ごとに 1 session 起動される orchestrator である。

1. `lh workflow run update` で表示用の current step / status / rework count を更新する。
2. `lh workflow launch-step` で Execute / Verify child を起動する。
3. `lh workflow step status` の配置済み artifact query だけを根拠に遷移する。
4. herdr を使って child の停滞を検知し、不足をつつく。
5. request_changes を Execute へ戻し、修正後は Verify を fresh session で起動する。
6. 上限超過や解消不能状態を issue comment + Inbox + needs-human 状態(run は `running` のまま
   待機理由を保持)で人間へ渡し、明示的な指示があるまで自動遷移を止める。
7. passing verdict で run を completed にする。merge はしない。

親はコード、review、PR body を直接編集しない。入力合成・schema validation・placement は engine
の責務である。

### 3.3 Execute agent

Execute は従来の Plan と Reflect を内包する。

1. `task.md` と関連コードを読み、最小の実装計画を作る。
2. 計画の対象、再利用する API / module、scope boundary、verification を session 内で明確にする。
3. 計画に従って実装し、repo 標準の test / lint / typecheck を実行する。
4. evidence を収集し、acceptance criteria ごとの結果を確認する。
5. 作業の friction、改善案、follow-up を振り返る。
6. 最後の commit 後に `execution-report` を提出する。

計画を独立 artifact として先に提出する gate は設けない。計画は Execute の生きた session context
にあり、人間が pane へ介入して変更できる。提出される reflection は execution-report の一部で、
実装結果と同じ SHA に結びつく。

### 3.4 Verify agent

Verify は従来どおり Execute から独立する。launch 時に pin した diff と report を読み、必要な
テストを再実行し、`pass` または `request_changes` verdict を提出する。source は編集せず、
指摘は verdict に記録する。`changes.diff` がレビュー対象の唯一の正本であり、Verify は
`git diff <fixed-point>...HEAD` などで対象 diff を再計算、置換、拡張しない。

利用可能で有用な review skill、レビュー手法、補助 agent は、固定入力、source 非変更、テスト実行
可、verdict artifact 提出という Verify contract の境界を守る場合に限り、任意の補助手段として
利用できる。たとえば `code-review` skill の Standards / Spec の二軸は利用できる一方、対象 diff
の作り直し、source の修正、別形式の最終レポートを要求する手順は調整または省略する。一般的な
skill であることだけを理由に拒否せず、逆に skill の手順で contract を上書きもしない。

skill が利用できない、有用でない、または固定 diff / artifact contract に適合しない場合は、現在の
入力を直接レビューすればよい。skill や補助 agent から得た指摘も Verify 自身が検証し、現在の
verdict schema に対応付ける。完了条件はレビュー経路にかかわらず、`lh workflow step output` に
よる verdict の受理だけである。

## 4. workflow 定義

workflow は global な prompt bundle として DB に保存する。

```sql
CREATE TABLE workflows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  description     TEXT NOT NULL DEFAULT '',
  execute_prompt  TEXT NOT NULL DEFAULT '',
  verify_prompt   TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
```

- prompt は plain markdown。空文字は built-in contract だけで動くことを表す。
- Settings の Workflows UI は Execute prompt / Verify prompt の 2 textarea を表示する。
- CLI は `--execute-prompt` / `--verify-prompt` と `--step execute|verify --file` を受け付ける。
- RPC / wire type も `execute_prompt` / `verify_prompt` のみを公開する。
- 旧 `plan_prompt` / `reflect_prompt` の保持・移行は行わない。

run の current step と artifact step は `execute | verify` のみである。新しい run は
`current_step: execute` で開始する。

## 5. artifact model

出力 artifact は **execution-report / verdict の 2 型**で固定する。ユーザー定義型は作らない。

### 5.1 execution-report

```jsonc
{
  "type": "execution-report",
  "summary": "変更内容の要約",
  "acceptance": [
    { "criterion": "AC の原文", "met": true, "note": "結果または未達理由" }
  ],
  "tests": [
    { "command": "npm test", "passed": true, "excerpt": "42 passed" }
  ],
  "evidence": [
    { "kind": "test | cli | screenshot | na", "description": "示す内容", "path": "任意の相対 path" }
  ],
  "reflection": {
    "went_well": ["うまくいったこと"],
    "friction": [ { "what": "詰まったこと", "cause": "原因" } ],
    "suggestions": [
      { "target": "step-prompt | contract | engine", "text": "改善案" }
    ],
    "followups": [ { "title": "後続候補", "rationale": "分ける理由" } ]
  }
}
```

`acceptance` / `tests` / `evidence` / `reflection.went_well` は 1 件以上必須。その他の reflection
配列は 0 件でもよい。engine は提出時の worktree head を artifact に刻印する。

placement:

- PR body の Summary / Acceptance criteria / Test plan / Evidence / Reflection を更新する。
- `evidence[].path` がある場合、kind にかかわらず attachment として upload し、PR body に
  embed する。path は worktree 内の regular file を指す相対 path でなければならず、symlink と
  worktree 外への escape は拒否する。`screenshot` kind では path が必須である。
- draft PR を ready にする。
- placement kind は `pr-body-report`。

### 5.2 verdict

```jsonc
{
  "type": "verdict",
  "event": "pass", // pass | request_changes
  "summary": "判定理由",
  "findings": [
    { "file": "path", "line": 12, "problem": "問題", "expected": "期待状態" }
  ]
}
```

`request_changes` では finding が 1 件以上必須。verdict は Verify launch 時に pin した SHA に
刻印し、その SHA に対する PR review として配置する。

### 5.3 完了条件

| step | 完了条件 |
|---|---|
| Execute | 配置済み execution-report の SHA が現 head と一致し、head が base より先行している |
| Verify | 配置済み verdict の SHA が現 head と一致している |

head が進むと両 step は自動的に stale になる。完了は PR body や pane の文字列ではなく、
`workflow_artifacts` × `workflow_placements` と現 head から pure query で計算する。

## 6. 入力合成

`lh workflow launch-step` は `$LOOPHUB_HOME/runs/workflow/<run>/<step>/input/` に入力を作る。

| step | 入力 | 合成元 |
|---|---|---|
| Execute | `task.md`、rework 時 `findings.md` | issue title/body/comments、最新 request_changes verdict |
| Verify | `task.md`、`changes.diff`、`report.md`、必要なら `prior-verdicts.md` | issue、pin 済み diff、execution-report、過去 verdict |

Execute に `plan.md` は渡さない。Execute 自身が task とコードから計画する。Reflect 用の
`run-digest.md` も作らない。振り返りに必要な情報は Execute が自分の session と作業結果から
execution-report に記録する。

契約は `core/workflow/contracts/execute.md` / `verify.md` / `parent.md` に置く。Claude では契約を
system prompt channel、入力一覧・workflow 固有 prompt・親 note を user prompt channel へ分離する。
Codex には system prompt 用の flag がないため、render 済み契約と user prompt をこの順で 1 つの
positional prompt に連結する。どちらの runtime でも契約の内容と workflow 固有入力は合成前の
データとして分離して管理するが、実行時の channel による構造的分離を前提にできるのは Claude
だけである。Workflow 固有の Verify prompt は review skill やレビュー観点を推奨できるが、固定
contract に追加される補助指示であり、contract と衝突する部分は無効である。

## 7. 親の遷移

| From | step status | Action |
|---|---|---|
| start | run started | Execute を launch |
| Execute | execute complete | Verify を fresh launch |
| Verify | pass | run を completed にして停止 |
| Verify | request_changes | rework count を増やし Execute へ戻す |

rework 上限は 3。生きている Execute pane を優先して再利用し、閉じていれば再 launch する。
修正後の Verify は常に fresh child とする。

同じ step を 2 回つついても完了しない、child launch が繰り返し失敗する、conflict が解消できない、
または rework が上限を超える場合、親は次を行う。

1. issue comment に経緯を残す。
2. Inbox で人間へ通知する。
3. `lh workflow run update --needs-human <reason>` で待機理由を保存する。run は `running` のまま
   (active 扱い)で、親は自動遷移をすべて止めて同じ session への人間の明示的な指示を待つ。

人間が続行を指示したら、親は `--clear-needs-human --rework-count 0` で待機を解除して自動 rework
枠をリセットし、`lh workflow step status` で現在の artifact と head を再確認して、同じ run を
Execute または fresh Verify から再開する。人間の指示がない限り自動再開しない。キャンセルは
`--status stopped`(再開しない終端)。過去の escalation と人間介入は run history に残る。

run の status は `running | completed | stopped` のみ。かつての終端 `blocked` status は廃止した。
既存の `blocked` run は履歴上そのまま残り、UI では needs-human 中の run と同じく Needs human と
して表示される(終端扱い)。親 session が失われているため再開はできない(新しい run を開始する)。

## 8. CLI / UI

```sh
lh workflow create <name> [--execute-prompt <text>] [--verify-prompt <text>]
lh workflow update <name> [--step execute|verify --file <path|->]
lh workflow start <issue> --workflow <name>
lh workflow launch-step --run <id> --step execute|verify
lh workflow step input <run> <step>
lh workflow step output [--run <id> --step execute|verify] [--file <path|->]
lh workflow step status <run> --json
```

issue / PR detail の run tracker は `Execute → Verify` を表示する。completed run の current step が
Verify の場合は passing verification で全 step を終えたことを示す。人間待ち中の run と legacy
`blocked` run は Needs human バッジと issue / Inbox へのリンクを目立つ形で表示し、needs-human 中の
run はさらに待機理由を示す(legacy `blocked` run は待機理由を持たない)。

## 9. skill / domain 非依存

- 親・子の contract と composed prompt に slash command を含めない。
- 子の出力は `lh workflow step output` のみ。issue / PR 番号や placement 先は artifact schema に
  含めない。
- child は task / findings / diff / report をファイルとして受け取り、domain API を直接呼ばない。
- engine が schema validation、SHA stamp、placement、complete query を担う。

## 10. 実装境界

| 層 | 責務 |
|---|---|
| `core/workflow/contracts/` | parent / Execute / Verify contract |
| `core/workflow/artifacts.ts` | execution-report / verdict の型と pure validation |
| `core/workflow/inputs.ts` | Execute / Verify 入力合成と安全な file write |
| `core/workflow/placement.ts` | report → PR body、verdict → review の placement |
| `core/workflow/steps.ts` | 2 step の completion query |
| `core/service/workflow-runs.ts` | run start、child launch、output、status、rework 基盤 |
| `core/store/workflows.ts` / `core/serialize.ts` | 2 prompt の persistence / wire shape |
| `cli/commands/workflow.ts` | thin CLI |
| `web/src/components/workflows-page.tsx` | Execute / Verify prompt editor |
| `web/src/components/workflow-run-status.tsx` | Execute → Verify tracker |

## 11. 検証観点

- 新しい run が Execute から始まり、Plan / Reflect を launch・submit できない。
- Execute input に issue comments が入り、`plan.md` は存在しない。
- execution-report は reflection を必須にし、PR body に配置される。
- status は Execute / Verify の 2 key だけを返し、head advance で両方 stale になる。
- passing verdict で親が run を completed にできる。
- Settings UI、RPC、CLI に Plan / Reflect prompt が現れない。
- run tracker が Execute → Verify の 2 step を表示する。
- Verify の SHA pin、fresh session、request_changes rework は従来どおり機能する。
- escalation は run を `running` のまま needs-human hold として保持し、待機中は launch-step が
  拒否され、人間の明示的な指示(`--clear-needs-human`)まで自動遷移しない。解除で rework 枠が
  0 に戻り、escalation と人間介入が run history に残る。
