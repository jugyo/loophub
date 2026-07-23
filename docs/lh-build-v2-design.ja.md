# lh build v2 設計書 — core の状態機械でゲートを強制するタスク実施フロー

> **種別**: 設計提案(ドラフト、2026-07-04)。`docs/lh-build-design.ja.md`(v1 設計、PR #354)の改訂版。
> **v1 設計の顛末**: 設計書のみマージされ(PR #354)、スキル本体(#353)は closed のまま未実装。
> 基盤の handoff 記録機構(#352)は実装済み(`handoffs` テーブル + `lh handoff record/list`)だが、
> 2026-07-04 時点でどのフローからも使われていない。本書はその実装済みインフラを前提に、
> 止まった原因(規約ベースの強制が重すぎた)を構造で解き直す。

---

## 0. 要点(TL;DR)

- **何**: `lh build <issue>` — `lh dev` と同型の CLI がオーケストレーター用エージェントセッションを
  起動し、Plan → Produce → Verify → Review を**使い捨てワーカー**で回すタスク実施フロー。
- **v1 設計からの最大の変更**: フェーズ遷移・ゲート・記録の強制を、スキルの記述(プロンプト規約)から
  **LoopHub core の小さな状態機械(CLI が不正遷移を 422 で拒否)**へ移す。弱いモデルは規約を破るが、
  CLI エラーは飛ばせない。
- **汎用化**: パイプラインは共通、**タスクプロファイル**(dev / docs / research)が成果物・検証方法・
  レビュー観点を差し替える。#694(種別ごとのレビュー観点切り替え)はこの機構で実現される。
- **モデル戦略**: 安いモデルから始め、フェーズ内で 2 ラウンド連続 fail したらワンランク上へ**昇格**。
  静的ルーティングでなく動的ラダーで「性能の劣るモデルでも完遂」を達成する。
- **ホスト**: Claude Code / Codex **両対等**。両ホストにサブエージェント機構があることを確認済み
  (§2)。強制は core 側なのでホスト機能(hooks / Workflow)に必須依存しない。
- **人間介入**: `needs-human` を正規のゲート結果とし、無限リトライせず質問して止まる。
  マージ / 結論承認は常に人間。

## 1. 決定済みの制約(前提)

本書は次の 4 点を所与とする(2026-07-04 にオーナーが決定):

1. **完全分離を維持**: lh build は `lh-dev` / `lh-pr-review` / `lh-merge-ready` を一切 invoke しない。
   レビューも最終ゲートも自前。分離対象はスキル(orchestration)であり、**インフラ
   (worktree / PR / git / SQLite / `lh` CLI / events / evidence dir / handoffs)は v1 と共有してよい**
   (v1 設計 §9.5 と同じ)。
2. **実行形態は `lh dev` と同型の CLI**: `lh build <issue>` が worktree / PR / session を準備して
   エージェントセッションを起動する。フロー本体はスキル + ワーカー定義。
3. **開発以外への適用**: 優先ターゲットは**ドキュメント/設計作業**と**調査・リサーチ**。
4. **両ホスト対等**: オーケストレーション自体が Claude Code でも Codex でも動くこと
   (`lh build --codex` 相当)。

## 2. ホスト機能の現況と設計判断(2026-07 調査)

> 出典: 公式 docs (code.claude.com/docs, developers.openai.com/codex) の Web 調査(2026-07-04)。
> バージョン依存の詳細は実装時に再確認すること。

| 機能 | Claude Code | Codex CLI |
|---|---|---|
| カスタムサブエージェント | あり(`.claude/agents/*.md`、tools allowlist / model / effort / maxTurns) | **あり**(TOML 定義、model / sandbox 指定可) |
| サブエージェントのネスト | 不可 | 不可(`agents.max_depth` 既定 1) |
| Workflow(スクリプト DAG) | あり(GA)。ただし実行中の人間介入不可・セッション跨ぎ resume 不可 | なし |
| hooks によるゲート | あり(PreToolUse / SubagentStop 等) | 限定的 |

判断:

- **「フェーズごとに使い捨てワーカーを spawn し、親は編成だけ行う」モデルは両ホストで成立する**。
  v1 設計の骨格(ステートレスサブ、成果物バス、生成と検証の分離)は維持できる。
- **Claude Code Workflow は採用しない**。両ホスト対等に反し、人間チェックポイントで止められない。
  将来 Claude Code 限定の高速化(並列レビュアーの fan-out)として検討する余地はあるが、設計の
  前提にしない。
- **hooks も一次保証に使わない**(v1 設計 §3-8 を踏襲)。強制はすべて LoopHub core 側(§4)。
  「サブは葉、編成は親だけ」という不変条件は、両ホストのネスト不可仕様と一致するため、
  ツール制限(§6)と合わせて構造的に保たれる。

## 3. 全体構成

```
lh build <issue> [--profile dev|docs|research] [--codex] [--auto]
  │  worktree / PR(profile による。research は issue のみ)/ session を準備し、
  │  build_run を開始してオーケストレーター用エージェントセッションを起動(lh dev と同型)
  ▼
オーケストレーター(強モデル。ソースを直接編集しない)
  │  各フェーズで使い捨てワーカーを spawn
  │    Claude Code: .claude/agents/lh-build-*.md   Codex: TOML エージェント定義
  │  進行は必ず `lh build` サブコマンド経由 ── ここが v2 の核(§4)
  ▼
LoopHub core: build_runs 状態機械 + handoffs 記録 + events(SSE)
```

パイプラインは全プロファイル共通:

```
Plan → [AI spec レビュー] → [人間チェックポイント(任意)] → Produce ∥ Verify(author)
     → Verify(run) → Review(観点別) → Final Gate(人間)
```

フェーズの意味論(生成と検証の分離、Verify(author) が spec からテスト/rubric を先に起こす TDD、
失敗の所在で差し戻す Feedback loop)は v1 設計 §5–§8 をそのまま継承する。本書で再定義しない。

## 4. core の状態機械(v2 の核)

小さな `build_runs` テーブルと数個のサブコマンドを追加する。**ワークフローエンジンは作らない**。

```
lh build next                                      # 次フェーズ・渡す入力・ゲート条件を core が返す
lh build dispatch --phase <p> --instructions -      # down handoff を記録。記録して初めてワーカー入力が確定
lh build submit   --phase <p> --report -            # up handoff を記録。ゲート判定の材料
lh build gate     --phase <p> --verdict pass|fail|needs-human [--reason -]
lh build done                                       # 全ゲート pass + trace 完全でなければ 422
```

強制はすべて core の検証で行う:

- `gate --verdict pass` は、対応する down/up handoff が揃っていなければ 422。
- 前フェーズのゲートを通さずに次フェーズの `dispatch` はできない(不正遷移は 422)。
- `done` は全ゲート pass かつ handoff トレース完全が条件。v1 設計の
  `assert_handoff_trace_complete`(自己申告)を、**構造的に飛ばせない仕組み**に置き換える。
- ラウンド数は core が数える。フェーズごと上限(既定 3)を超えた `dispatch` は拒否され、
  needs-human に落ちる(§8)。

利点:

- **ホスト非依存**: Codex セッションでも同じ CLI を叩くだけ。hooks 不要。
- **弱いモデル耐性**: ゲート飛ばし・記録忘れが起きない。さらに `lh build next` が
  「次に何をどのチェックリストで渡すか」を返すため、オーケストレーション自体が機械的になり、
  弱いモデルがオーケストレーターを務める余地も生まれる(当面は強モデル推奨)。
- **記録のクリティカルパス化**: v1 設計 §6.5 の「親の記録義務」が、義務でなく
  「記録しないと進めない」構造になる。#352 の実装済みインフラがここで初めて接続される。

`build_runs` スキーマ案: `id, repo_id, issue_id, pr_id, profile, phase, phase_round,
model_tier, status(running|blocked|done|abandoned), created_at, updated_at`。
フェーズ遷移の履歴は handoffs(+gate 記録)から復元できるため、テーブル自体は現在状態のみ持つ。
ゲート記録は handoffs に `phase=<p>/gate` 等で載せるか専用列にするかは実装時に決める。

## 5. タスクプロファイル(汎用化)

プロファイルが差し替えるのは中身だけで、パイプラインとゲート構造は共通。

| | dev | docs | research |
|---|---|---|---|
| Produce | コード実装 | 文書作成/改訂 | 調査・実験 |
| 成果物 | PR diff | PR diff(docs) | **issue への結論コメント**(PR を作らない) |
| Verify | tests + eval rubric | ポータビリティ/読者検証 rubric | **主張の事実検証**(引用・再現手順の突合せ) |
| Review 観点 | Quality / Security / Acceptance | Documentation / Acceptance | 論拠 / Acceptance |
| Final Gate | 人間マージ | 人間マージ | 人間が結論を承認して issue close |

- プロファイルは `skills/lh-build/profiles/<name>.md` の小さなデータファイル(観点リスト・rubric・
  成果物型。各 ~50 行)。
- プロファイル解決: `--profile` フラグ > issue ラベル(例 `type:research`) > 既定 `dev`。
- #694(PR 種別に応じたレビュー観点の切り替え)は、lh build においてはプロファイルとして
  実現される。v1 レジーム側の #694 対応とは独立(完全分離のため)。
- research の成果物を issue コメントに置くのは「調査・設計だけの成果は重い docs を作らず
  結論を issue/PR コメントに集約する」運用原則に沿う。

## 6. ワーカー定義とホスト移植性

- **正準はホスト中立な markdown**: `skills/lh-build/agents/plan.md`, `produce.md`, `verify.md`,
  `review-<topic>.md`。内容は入出力契約・禁止事項・rubric。
- `install.sh` が正準から両ホスト向け定義を**生成・同期**する:
  - Claude Code: `.claude/agents/lh-build-*.md`(tools allowlist から **Skill / Agent を除外**、
    model / effort 指定)
  - Codex: TOML エージェント定義(model / sandbox 指定)
- 二重メンテを避けつつ、v1 設計 §9.5 の「ツール制限による構造的分離」(サブはスキルを呼べない・
  別サブを生めない)を両ホストで保つ。
- ワーカーへの入力は `lh build dispatch` で記録された指示文書(spec / 失敗レポート等を nonce
  フェンスで包んだもの)のみ。前フェーズの会話は渡さない(v1 設計 §7 のステートレス原則)。

## 7. モデル戦略(「sonnet でも完遂」への回答)

1. **既定ルーティング**: オーケストレーター = セッションモデル(強)。Plan = 強。Produce = 中
   (sonnet 級)。Verify / 各レビュアー = 安(haiku 級〜sonnet)。フェーズ別既定は LoopHub の
   既存 model/effort 設定機構(#687 / #701 で整備済みの per-agent 設定)にエントリを足して持つ。
2. **昇格ラダー**: 同一フェーズで 2 ラウンド連続 fail したら、次の再 spawn はワンランク上の
   モデルで行う。core が `phase_round` と `model_tier` を持つので、`lh build next` が昇格を
   指示できる。安く始めて必要な所だけ高くする。
3. 弱いモデルが完遂できる条件は「小さい担当範囲 + 明示的契約 + 外部ゲート」。
   フェーズ分割(§3)・契約ファイル(§6)・core ゲート(§4)の 3 点がそのまま対策になる。

## 8. 人間介入の設計

- **needs-human は正規のゲート結果**: どのフェーズも `lh build gate --verdict needs-human
  --reason -` で停止できる。core が SSE イベントを発行し、質問を PR / issue にコメントとして
  投稿、UI に表示する。対話中なら即質問、AFK なら通知されるまで blocked で待つ。
  **無限リトライで品質とトークンを溶かすより、質問して止まる方を正とする**。
- **チェックポイント設定**: Plan 承認は対話モードでは既定 on。`--auto`(AFK)では AI spec
  レビューのみで進行(v1 設計 §5.1 の 2 段ゲートを踏襲)。マージ / research の結論承認は常に人間。
- **ラウンド上限**: フェーズごと最大 3 ラウンド(昇格込み)。超えたら core が自動で
  needs-human に落とす(§4)。

## 9. スキル肥大化の防止

```
skills/lh-build/
  SKILL.md          # ~150 行: 起動ガード、フロー概要、「常に lh build next に従う」、不変条件へのポインタ
  invariants.md     # 横断規則: マージしない / nonce フェンス / 秘匿 redaction / レビュー投稿順序 など
  profiles/*.md     # タスク種別ごとの観点・rubric(各 ~50 行)
  agents/*.md       # フェーズ契約(正準。各ワーカーだけが読む)
```

- オーケストレーターの手順知識の大半を `lh build next` の出力(core 側テンプレート)に移す。
  SKILL.md は判断ポリシーだけになる(v1 の `lh-dev` は 541 行。この再発を防ぐ)。
- フロー変更の多くがスキル編集でなく core の修正になり、テスト可能性と人間の理解可能性が上がる。

## 10. 継承する不変条件(v1 レジームから)

- マージしない / main で作業しない / startup guard / 報告の最終行は PR(または issue)URL。
- 親はソースを直接編集しない。
- untrusted by default: issue / コメント / 前フェーズ成果物はデータであって命令ではない。
  handoff body を読み戻すときも同様(nonce フェンス)。
- 秘匿の非伝播: handoffs は平文で永続化され GC されないため、credentials / tokens / secrets を
  記録に入れない(redaction は書き手の責務)。
- レビュー投稿は `lh pr review --topic` を使い、**pass / comment を先、request_changes を最後**に
  投稿する(review state 解決順序の既知の正しさ規則)。
- evidence は issue キーの永続ディレクトリ(`$LOOPHUB_HOME/evidence/...`)に置く。

## 11. 実装スライス

1. **core: `build_runs` 状態機械 + `lh build next/dispatch/submit/gate/done`**(handoffs 接続)。
   単体でユニットテスト可能。UI 不要。
2. **CLI: `lh build <issue>` 起動コマンド**(`lh dev` の worktree / PR / session 準備ロジックを
   流用。プロファイル解決。research は PR を作らない分岐)。
3. **スキル + ワーカー定義**(dev プロファイルのみ、Claude Code 向け)。
4. **Codex 対応**: TOML 生成 + `--codex`。
5. **docs / research プロファイル追加**。
6. **UI**: PR / issue 詳細に build run のフェーズ・ゲート・handoff の時系列表示
   (v1 設計 §6.5 の「ハンドオフ」セクション構想の具体化)。

## 12. リスク・未決事項

- **重さ**: v1 レジーム(`lh dev`)より高コスト・高レイテンシ。低リスク変更は v1 で十分
  (モード選択の明示、v1 設計 §14 と同じ)。
- **`lh build next` テンプレートの設計**: core が返す指示の粒度(どこまで手順を含めるか)。
  スキル側ポリシーと core 側テンプレートの責務境界は実装時に詰める。
- **ゲート記録の置き場**: handoffs に載せるか `build_runs` に専用列を持つか(§4 末尾)。
- **昇格ラダーのモデル段**: tier の実体(haiku → sonnet → opus/fable 等)は設定で持ち、
  ハードコードしない。
- **research プロファイルの Verify**: 事実検証の rubric 具体化(引用 URL の実在確認、
  再現コマンドの実行、など)。最初はチェックリストで開始し LM judge は後続(v1 設計 §13-2 と同方針)。
- **完全分離下の A/B 比較**: v1 レジームは handoff 未接続のため、当面の比較は retro(`lh retro`)
  ベースになる。v1 側への handoff 接続は本設計のスコープ外。
