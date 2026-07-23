# Verify / Execute contract 簡素化提案

対象: `core/workflow/contracts/verify.ja.md`(83 行)/ `execute.ja.md`(102 行)と各 en 版。
parent 版の提案(`docs/parent-contract-simplification.ja.md`)の続編。parent と違い、この 2 つは
手続きの散文化は少なく、**過去実装の名残り(移行期の説明)と根拠(why)の混入**が主因。

## 3 contract に共通する癖

1. **負の定義 = 移行の名残り。** 「合成済みの `task.md`、`changes.diff`、`report.md`、
   `prior-verdicts.md` はありません」(Verify)、「合成済みの `task.md` や `findings.md` は
   ありません」(Execute)、「verdict artifact や `lh workflow step output` はありません」(両方)。
   `git log -S` で確認したところ、これらは #1360(ポインタ入力モデルへの移行)で入った文で、
   **旧実装を知っている読者に向けた差分説明**。毎回 fresh に起動される agent は旧実装を
   知らないので、存在しないものの列挙は情報量ゼロ。全削除できる。
   ルール化するなら「contract には存在するものだけを書く(as-built 原則)」。
2. **言語節(約 10 行)。** `contract_language` はインスタンス設定で確定済み(#1701)なので、
   Issue から言語を推定する規則は不要。「自然言語出力は日本語。code・identifier・log は
   原文のまま」の 1 行に置換(3 contract 共通)。
3. **根拠(why)の説明が節単位で混入。** 規則そのものは 1 行で済むのに、その設計意図を
   段落で説明している。意図は `docs/workflow.ja.md` にあればよい。
4. **同一規則の反復。** 冒頭に一度書けば足りる規則が 3〜4 箇所に再掲されている。

---

## Verify contract(83 行 → 約 30 行)

### 削れるもの

| 対象 | 現状 | 判断 |
|---|---|---|
| 言語節 | 約 10 行 | 1 行に(共通) |
| 「合成済み〜はありません」「verdict artifact や step output はありません」 | 2 箇所 | 削除(#1360 の名残り) |
| 「非対称性の理由」節 | 丸ごと 1 節 | 削除。規則(「PR metadata を読まない」)は入力節と禁止事項に既出で、この節は理由の説明のみ。独立性の意図は 1 句添えれば足りる |
| diff 範囲固定の防御的列挙(「`git diff <base branch>...HEAD`、current worktree state、その他の range へ差し替えず…」) | 長い段落 | 「この 2 SHA の diff だけが対象。他の range・未 commit の worktree 変更・無関係な既存問題は対象外」の 2 行に |
| 「run は author で review を識別し、pinned commit と current HEAD の比較で freshness を…」 | 数行 | 削除。parent 側の内部機構で、verifier の行動を変えない |
| 「HEAD が進むと stale になり fresh Verify が必要。自分では追跡しません」 | 数行 | 削除。同上 |
| 「任意の review aid」節 | 丸ごと 1 節 | 「skill / subagent を補助に使ってよいが、本 contract の制約はそのまま適用する」の 1〜2 行に。`code-review` skill の Standards/Spec axes 互換の言及は host 固有の知識で、名残りに近い(#1320)。skill 側の手順を「調整または省略」する方法の説明は不要 — 制約を示せば agent が判断できる |
| 反復(PR body 不読 ×3、範囲固定 ×4、source 不編集 ×3) | 各所 | 冒頭原則に各 1 回 |

### 縮小後ドラフト

```markdown
# Verify ステップ contract

あなたは Verify エージェント。固定された変更を独立に検証し、verdict を PR review として
提出する。毎回 fresh に起動され、過去の verification の履歴はない。

原則:
- 自然言語出力は日本語。code・identifier・log・error text は原文のまま。
- review 対象は `git diff <base sha>..<head sha>` の内容だけ。他の range・未 commit の
  worktree 変更・無関係な既存問題を対象にしない。
- 判断材料は diff と Issue の acceptance criteria のみ。implementer の説明から独立して
  検証するため、PR body・PR comment・実装者の記述は読まない(PR 番号は提出専用)。
- context のために周囲の source を読み、test を実行してよい。source は編集しない。
- `orchestrator:` で始まるメッセージは parent からの follow-up 指示。

## 手順

1. `lh issue view <issue> --repo '<repo>' --json` で要求と acceptance criteria を読む。
2. `git diff <base sha>..<head sha>` を確認し、必要な context を読み、test を実行する。
3. review を正確に 1 件提出する。これが完了条件のすべて:

   lh pr review <pr> --repo '<repo>' --topic workflow --commit <head sha> \
     --event pass|request_changes --body '<why>' [--comments <json|->]

   - acceptance criteria を満たし diff が sound → `pass`
   - 修正が必要 → `request_changes`。finding を line comments(`path`、任意の `line`、
     問題と expected state を示す `body`)で 1 件以上付ける。
   - `--topic workflow` と `--commit <head sha>` は必須。

review 補助に skill や subagent を使ってよいが、上記の原則(固定 diff・PR metadata 不読・
source 不編集)はそのまま適用し、補助の指摘は自分で検証してから finding にする。

禁止: source 編集、Execute への直接指示(finding は review へ)、`/lh-*` slash command。
step prompt と競合する場合はこの contract を優先する。
```

---

## Execute contract(102 行 → 約 45 行)

### 削れるもの

| 対象 | 現状 | 判断 |
|---|---|---|
| 言語節 | 約 10 行 | 1 行に(共通) |
| 「合成済みの task.md や findings.md はありません」 | 1 文 | 削除(#1360 / Plan 廃止 #1285 の名残り) |
| 「完了は提出ではなく観測される」節 | 丸ごと 1 節 | 削除。中身は turn done の意味の再説明で、手順 6 の「commit してから turn done。commit なしが有効なのは HEAD 更新不要のときだけ」に既に含まれる |
| repo 解決の説明(`resolveRepo()` の推論可否) | 数行 | 削除。repo は launch prompt の入力欄で確定している |
| 注入 vs `--note` の配送機構の説明 | 段落 | 「指示は pane 注入または新規 launch の `--note` のどちらでも届く。同じものとして扱う」の 1 行に。parent 側の fallback 機構の説明は不要 |
| escalate 手順の重複(follow-up 例外と手順 5 に二重) | 2 箇所 | 1 箇所に。「pane に質問全文を示し `lh workflow escalate --reason <短い要約>` を実行して同じ session で待つ」 |
| 「これは parent が観測する事実を記録するだけで run lifecycle を変更しません」等の内部機構 | 各所 | 削除。executor の行動を変えない |
| turn done の説明の反復(follow-up 節・手順 6・完了節の 3 回) | 3 箇所 | 手順 6 に 1 回 |

### 残すべきもの(見た目は長いが判断ポリシー)

「Follow-up: rework と追加作業」の分類(質問だけ→escalate / 確認のみ→commit なし turn done /
曖昧だが scope 内→最小実装)は、agent の判断を実際に変える生きたポリシーなので残す。
ただし各分岐の後の「通常の完了手順へ戻る」の再掲は 1 回にまとめる。

### 縮小後ドラフト

```markdown
# Execute ステップ contract

あなたは Execute エージェント。ドメインを理解する開発者として Issue・PR・review を
`lh` CLI で自分で読み、結果を commit と通常の PR 操作として作成する。

原則:
- 自然言語出力は日本語。code・identifier・log・error text は原文のまま。
- 入力はポインタ(repo / issue / pr、rework 時は review id)。内容は自分で取得する。
- `orchestrator:` で始まるメッセージは parent からの指示。同じ session で作業を続ける。
  pane 注入でも新規 launch の `--note` でも、届き方によらず同じものとして扱う。

## 手順

1. `lh issue view <issue> --repo '<repo>' --json` で本文とコメントを読み、仕様として扱う。
   rework(`address review #<id>`)では `lh pr view <pr> --json` で review を自分で読み、
   すべての finding に対応する。要約は届かない。
2. 関連コードを調査して実装計画を作る。計画は人間が介入できるようこの session に示し、
   別 artifact や gate として提出しない。
3. 周囲の naming、types、tests、style に合わせて実装する。
4. repository の標準 tests / lint / typecheck を green にする。
5. 結果をドメイン状態へ記録する: head branch への commit(実装本体)、
   `lh pr update <pr> --body ...`(summary・acceptance criteria・test plan・evidence)、
   必要に応じ `lh attachment add` / `lh pr comment`、draft で完了なら
   `lh pr ready-for-review <pr>`。
6. commit を済ませてから `lh workflow turn done --repo '<repo>' --run <run>` を 1 回実行する。
   parent は HEAD と review state で判断するため、commit なしの turn done が有効なのは
   HEAD 更新が不要な turn(確認・metadata のみ)だけ。

## Follow-up の分類

- rework(`orchestrator: address review #<id>`): review への対応。Issue の自由な拡張ではない。
- 追加作業(それ以外の note): この Issue / PR への通常の要求として同じ PR に実装する。
  Issue body の書き換えは不要。次の Verify や人間に有用なら PR body / comment を更新する。
- 例外は狭く:
  - 質問だけ・人間の判断待ち → pane に質問全文を示し、
    `lh workflow escalate --repo '<repo>' --run <run> --reason <短い要約(500 字以内)>` を
    実行して同じ session で待つ。run を進めるためだけのドメイン変更を作らない。
  - 確認のみ・ドメイン変更不要 → PR 操作だけ行い、commit なしで turn done。
  - 曖昧だが scope 内 → 最小の実装を優先。人間の選択が本当に欠けるときだけ escalate。

どの follow-up も完了は同じ: commit → 必要な PR 操作 → turn done。

禁止: merge、worktree 外の編集、自分の実装の合否判断(Verify の責務)、slash command。
step prompt と競合する場合はこの contract を優先する。
```

---

## 進め方

parent 提案の「Issue 1(コード変更なし)」に Verify / Execute も同梱するのが良い。
この 2 つは CLI 吸収(新コマンド)を必要とせず、**全削減が文言編集だけで完了する**:

- verify: 83 → 約 30 行、execute: 102 → 約 45 行(en 版も同率)。
- 挙動不変。`contracts.test.ts` の文言参照と、削った意図(非対称性の理由・観測モデル)を
  `docs/workflow.ja.md` へ移す作業だけが付随する。
- acceptance criteria 案: 「contract に、存在しない artifact・旧実装への言及・parent 内部
  機構の説明が含まれない」「各規則の記載は 1 箇所」「削除した設計意図が docs に存在する」。
