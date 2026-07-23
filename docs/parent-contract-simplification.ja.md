# Parent workflow contract 簡素化提案

対象: `core/workflow/contracts/parent.ja.md`(316 行)/ `parent.md`(419 行)。
parent は long-running で、この contract は run の全 turn に載り続けるため、削減はそのまま
毎 turn のトークンコスト削減になる。en/ja の二重メンテコストも比例して下がる。

## 現状の肥大化の内訳

読み直すと、行数の大半は「判断ポリシー」ではなく次の 4 種に費やされている。

1. **メカニズムの散文化(最大の要因)** — pane 解決 4 手順、text の sanitize 規則、
   activate-step の順序、fallback 分岐、cost interrupt の 7 手順。これは shell script を
   日本語で書いたもので、agent の判断ではなく決定的な手続き。手続きはプロンプトではなく
   CLI が持つべきもの。
2. **同一規則の反復** — 「pane output / self-report は遷移事実ではない」系が 6 回以上、
   「Verify は常に fresh child」が 5 回、「finding を summarize しない」が 3 回出現する。
3. **設計根拠(why)の混入** — 「event は wake だけを担う」「receipt の曖昧 window」
   「audit は既存事実で復元できる」等。実行時に agent が必要とするのは規則だけで、
   根拠は `docs/workflow.ja.md` にあればよい。特に「Inject round の audit」節は
   まるごと設計文書であり、agent への指示を 1 つも含まない。
4. **環境側で解決済み・CLI が強制済みの事項** —
   - 言語節: `contract_language=ja` はアプリ設定で確定しているのに、Issue から言語を
     推定する規則(+encoding 攻撃への防御)を毎回書いている。「自然言語出力は日本語」の
     1 行で足りる。
   - repo 解決: `--repo` は Run コンテキストで確定しているのに `resolveRepo()` の推論可否を
     説明している。
   - CLI が拒否できる誤り: ack の cursor 照合、`increase-cost-limit --expected-limit` の
     CAS、pending receipt 中の ack 拒否。CLI がエラーで止めるなら、プロンプトで
     予防的に説明する必要は薄い(エラーメッセージ側に次の行動を書けばよい)。

## 簡素化の原則

- **ゴールからの reconcile として書く。** 現状を観測 → ゴールとの gap を判定 → 足りない分だけ
  子を動かす、のループとして構成する(詳細は次節)。event 種別ごとの手順羅列にしない。
- **プロンプトは判断ポリシー、手続きは CLI。** 決定的な多段手順が出てきたら、それは
  コマンドに吸収するサイン(`cli/` thin / `core/service` の方針と同型)。
- **1 規則 1 記載。** 冒頭の原則に一度書き、各節で繰り返さない。
- **CLI が構造的に防げる誤りは書かない。** 誤操作は CLI が non-zero + 誘導メッセージで返す。
- **why は docs へ、what だけ contract へ。**

## Reconcile モデルへの再構成(構成の柱)

現行 contract は既に「**event は wake だけを担い、判断は domain state で行う**」と宣言して
いる。これは level-triggered な reconciliation loop の思想そのものだが、文書の構造は
event 種別ごとの手順書(edge-triggered な playbook の羅列)になっており、思想と構成が
食い違っている。この食い違いが反復の温床になっている — 同じ「観測してから判断せよ」を
event の数だけ再説明しているからである。

ゴール状態を先に定義し、「wake → 観測 → gap 判定 → action 1 つ → ack」のループとして
書き直すと、次が構造的に消える。

1. **遷移表が「ゴールから導出される gap の一覧」になる。** merge conflict / GitHub feedback /
   out-of-band review / 人間の追加指示の各節は「満たすべき要求が増えた、という gap への翻訳
   1 行」に潰れ、以後は同じ表に従うだけになる。
2. **replay / at-least-once の注意書きがほぼ消える。** reconcile は毎回観測から判断するので、
   event の replay は構造的に無害。durable receipt が必要なのは edge-triggered な副作用
   (Esc、人間への確認、通知)だけになり、「Interrupts」として明示的に隔離できる。
3. **新しい event 種別を追加しても prompt が伸びない。** wake に過ぎないため、gap への翻訳が
   自明なら記述ゼロで済む。

### 前提を強める CLI 変更(推奨)

`lh workflow step status` を「**完全な observed-state 文書**」にする。現状、hold 状態
(await-human)、rework count、未対応の out-of-band review、pending effect receipt の一部は
event payload でしか届かず、そこだけ event が事実を運んでしまっている。これらを step status に
含めれば「事実は step status だけ」が例外なく成立し、event→gap の翻訳の記述も縮む。

### reconcile に馴染まないもの(意図的に外に置く)

cost interrupt の Esc・人間確認・pane 通知は本質的に edge-triggered な一回性の副作用で、
観測からは再導出できない。これらは reconcile loop の外の「Interrupts」節に隔離し、
effect receipt はここにだけ残す。

## 遷移判断そのものを CLI へ: `lh workflow next`(仮称)

reconcile 構成にすると、gap → action の対応は**決定的な分類**になる。決定的なら LLM が
プロンプト内の表を読んで判断する必要はなく、core の pure module(例
`core/workflow/reconcile.ts`)に移して CLI として公開できる。**次に何をすべきかはコマンドが
教えてくれる**形になる。

```
lh workflow next --repo '<repo>' --run <run> --json
→ { "action": "launch_execute" | "advance_and_verify" | "request_rework" | "deliver"
     | "wait" | "escalate" | "ask_human", "reason": "<観測事実に基づく説明>",
     "review_id": 12, ... }
```

- **副作用なし・冪等の advisory。** 入力は step status と同じ observed state だけで、
  何度呼んでも同じ答え。transition command はこれまでどおり別に実行する。
- **parent に残る判断は自然言語の生成だけになる。** 無進捗時の follow-up 文の作成、
  escalation の要約、GitHub feedback を読んで要変更かを決める判断など。next はそれらを
  `deliver`(text は parent が書く)や理由付きの `escalate` として返し、中身は書かない。
- **AGENTS.md の責務分割と同型。** pure な decisioning は core module へ、CLI は薄く。
  gap 表が unit test 可能になり、判断ロジックの変更が contract 文言の変更から独立する。
- **人間の診断ツールにもなる。** run が止まって見えるとき `lh workflow next` を叩けば
  「何を待っているか・なぜか」を説明する。
- **決定的 parent への移行路。** 将来、worker が next を呼んで NL 不要な action
  (`advance_and_verify`、`request_rework` の transition 部分など)を自動実行し、
  NL が必要な action(`deliver` の文面、escalation 要約)のときだけ LLM を起こす、という
  段階的置き換えができる。LLM parent は「next が要求したときだけ呼ばれる部品」へ縮退していく。
- **注意: 判断の二重化を避ける。** next 導入後は contract から gap 表を削除し、
  「next に従う。各 action の実行方法は次のとおり」だけを残す。prompt と code の両方に
  判断表があると、食い違ったときにどちらが正か曖昧になる。

### watch も next に内包できる(`next --watch`)

event の polling も parent の仕事である必要はない。blocking 形
`lh workflow next --run <run> --watch --json` が event の受信・durable cursor の前進・
状態観測・判断までを内包し、「実行すべき action」だけを返す形にできる。

- **reconcile 化により、cursor は正しさの機構ではなく wake の機構に格下げされる。**
  現行の ack protocol は「event を処理してから ack」で at-least-once を成立させるための
  ものだが、next は毎回観測から判断するので、action 実行前に parent が停止しても
  再起動後の next が同じ state から同じ action を返す。ack を parent に見せる理由が消える。
- **前提は Issue 4(observed state の完全化)。** out-of-band review の id、GitHub feedback の
  参照、cost payload が event にしか無い間は、event 自体を parent に見せる必要が残る。
  完全化すれば event は純粋な wake になり、cursor 管理を CLI 内部に畳める。
- **一回性の副作用の guard は残す。** 「同じ state → 同じ action」の再実行は、Esc・通知・
  escalation comment のような一回性の副作用を二重発火させ得る。これは actuator 側の
  effect receipt で引き続き guard する(deliver の重複注入も receipt で防げる)。
- **純粋性は層で保つ。** core の `reconcile(state) → action` は pure のまま、CLI が
  watch + status + reconcile を合成する。unit test は pure 関数に書く。

これで parent の loop は「`next --watch` を background task で開始 → 起きたら action を実行 →
繰り返し」の 3 行になり、watcher protocol・ack・replay の記述は contract から完全に消える。

## レバー(効果順)

### A. コード変更なしで削れる(316 行 → 推定 130〜150 行)

reconcile 構成への書き換え自体もコード不要(文書構成の変更)なので、ここに含む。

| 対象 | 現状 | 案 |
|---|---|---|
| 文書構成 | event 種別ごとの手順書 | ゴール定義 + reconcile loop + gap 表 + Interrupts に再構成 |
| 言語節 | 約 10 行(言語推定+防御) | 「自然言語出力は日本語。code・log・identifier は原文のまま」の 1 行 |
| Inject round の audit 節 | 約 10 行 | 削除(指示が無い。内容は docs へ) |
| 反復規則 | 各所に散在 | 冒頭「原則」に集約 |
| コマンド一覧 | 各コマンドにフラグ形式+意味+注意 | 「いつ使うか」だけの 1 行ずつに圧縮。フラグの正確な形式は `--help` と launch 時の Run コンテキストに任せる |
| rework / continuing / conflict / out-of-band / GitHub の各節 | それぞれ手順を再掲 | gap への翻訳 1 行ずつに統合 |
| watcher protocol の復旧説明 | 2 段落 | 「処理前に落ちたら `--ack` を省略。同じ event が replay される(reconcile は観測から判断するので replay は安全)」の 2 行 |
| 設計根拠の文 | 各所 | 削除し docs/workflow.ja.md へ |

### B. CLI へのメカニズム吸収(さらに削って推定 35〜60 行)

0. **`lh workflow next`(仮称)** — 遷移判断そのものを CLI 化(前節)。gap 表が contract から
   消え、parent は「next に従い、自然言語が必要な部分だけ考える」役になる。
1. **`lh workflow deliver`(仮称)** — 実行系では最大のレバー。
   「最新 executor の解決 → `pane_id` 取得 → activate-step → newline/control chars の
   collapse → `herdr pane run` → 失敗時 non-zero と理由」を 1 コマンドに。
   contract の「Live child control」+「Instruction injection」約 60 行が 3 行になる:
   `lh workflow deliver --run N --text 'orchestrator: ...'`、失敗したら
   `launch-step --note` へ fallback、の 2 規則だけ残る。
   launch-step が既に herdr 起動を内包しているので、herdr 依存の置き場所としても整合する。
2. **`lh workflow step status` の observed-state 完全化** — 上記 reconcile 節のとおり。
   hold 状態・rework count・未対応 out-of-band review・pending receipt を含める。
3. **cost interrupt の合成コマンド(`lh workflow cost-hold` 仮称)** —
   await-human + Esc(send-keys)+ pane 通知 + effect receipt を 1 コマンド・1 receipt に。
   contract 側は「cost_exceeded → cost-hold → 人間に yes/no → yes なら
   increase-cost-limit && resume、no なら待つ」の 5 行になる。
   `pane run Escape` の誤用注意のような罠の説明もコマンドごと消える。
4. **`lh workflow escalate-human`(仮称)** — Issue comment + Inbox send + receipt を
   1 コマンドに。「必ず両方を行います」の段落が 1 行になる。
5. **`lh workflow watch` の結果に step status snapshot を同梱(任意)** —
   wake → 観測 → 判断が 1 応答で完結し、turn の往復が 1 回減る。

### C. やらないほうがよいこと

- **コアループと稀 event playbook の文書分割・遅延ロード**: 参照解決という新しい機構が
  増え、single-file の可搬性が落ちる。単一文書のまま頻度順に並べる方が simplest correct。
- **防御文言の一括削除**: 個々の禁止事項(`pane run Escape` の罠、idle detection 禁止など)は
  過去の実障害由来の可能性がある。削る場合は「CLI 側の強制に置換してから削る」を原則にし、
  プロンプトからの単純削除はしない。由来は `git log -p core/workflow/contracts/` で確認できる。

## 縮小後の contract ドラフト(reconcile 構成、B 実施後の姿)

```markdown
# Parent workflow contract

あなたはこの run の parent orchestrator。ゴール状態に向けて run を reconcile し続ける。
code の編集・review・PR 操作・merge はしない。

## ゴール状態

Issue の要求を満たす commit 群が PR head にあり、その HEAD に pin された fresh な pass
review が存在すること。到達後も run は running のまま、人間の指示や新しい event で gap が
生まれたら reconcile を再開する。run を終えるのは人間だけ。

## Reconcile loop

1. `lh workflow next <run> --watch --json` を runtime の background task で開始し、turn を
   終える(event 受信・cursor 管理・観測・判断は next が内包する。shell の `&` / nohup /
   手動 poll は使わない)。
2. 再開したら、返された action を実行する(下記)。事実は同梱の observed state だけ。
   pane 出力・child の自己申告は事実ではない。
3. 1 に戻る。command が non-zero なら retry せず、error を表示して人間の判断を待つ。

(初回の Execute 起動も next が `launch_execute` として返す。)

## Action の実行

- `launch_execute` / `launch_verify` — `lh workflow launch-step`。Verify は常に fresh child
  (verifier session を再利用しない)。
- `advance_and_verify` — `advance-to-verify` → fresh Verify launch。
- `request_rework` — `request-rework` → `deliver 'orchestrator: address review #<id>'`。
  finding は要約せず id だけを渡す。
- `deliver` — reason(無進捗の follow-up、人間の追加指示、merge conflict、GitHub feedback、
  out-of-band review)に応じた single-line 指示文を自分で書き、
  `lh workflow deliver --text 'orchestrator: ...'` で送る。GitHub feedback は `gh api` で参照を
  読み、要変更かは自分で判断する。失敗時は `launch-step --step execute --note <instruction>`
  (rework は `--review <id>`)へ fallback。
- `wait` — gap なし(fresh pass)または hold 中。何もしない。
- `escalate` — `escalate-human --reason <要約>` を実行して hold にし、人間の指示を待つ。
- `ask_human`(cost)— 下記 Interrupts のとおり。

## Interrupts(reconcile の外。edge-triggered な一回性の副作用)

- `cost_exceeded`: `lh workflow cost-hold --event <id>` を実行し、
  「Cost limit exceeded. Continue?」を yes / no で人間に問う。
  yes → `increase-cost-limit --expected-limit <limit_usd>` 成功後に `resume`、Execute へ
  再開指示を deliver(Verify 中断なら fresh Verify)。no → hold のまま何もしない。
(rework 3 超過、無進捗 turn-done の反復、launch 連続失敗、child の escalation 宣言は
next が `escalate` として返す。)

## 禁止

- merge、source 編集、PR 編集。
- child session の resume・fork。idle 検知や pane output による遷移判断。
- 自然言語出力は日本語。code・identifier・log・error text は原文のまま。
```

約 30 行。現行 316 行から約 90% 減。段階ごとの姿:

- A のみ(コード変更なし): 130〜150 行。gap 表と inject 手順への参照が contract 内に残る。
- next なしの中間形(deliver 等の actuator のみ実装): 約 55 行。gap 表と watch/ack を
  contract 内に持つ。
- next あり + `--watch` 内包(上記ドラフト): 約 30 行。判断表は core のコードと unit test に
  移り、watcher protocol・ack・replay の記述が消える。

## 進め方の提案

1. **Issue 1(コード変更なし)**: reconcile 構成への書き換え + A の文言編集で
   parent.ja.md / parent.md を約半分に。挙動不変、contracts.test.ts の文言参照だけ追随。
2. **Issue 2(`lh workflow next`)**: 判断の pure module 化(`core/workflow/reconcile.ts` 仮)+
   CLI 公開。contract から gap 表を削除(判断の二重化を残さない)。この時点では
   watch + next の 2 コマンド構成。
3. **Issue 3(actuator 合成)**: `deliver` / `cost-hold` / `escalate-human` を実装し、
   手続き記述と effect receipt の露出を置換。
4. **Issue 4(step status の observed-state 完全化 → `next --watch`)**: hold 状態・
   rework count・未対応 out-of-band review・pending receipt を含め、next の入力を例外なく
   domain 状態にする。event が純粋な wake になった時点で `--watch` を追加し、
   polling と cursor 管理を next に内包。contract から watch/ack の記述が消える。

## 終盤形: parent から LLM を外す

next + actuator が揃うと、parent に残る LLM 判断を数えられるようになる。

- 無進捗 Execute の診断と follow-up 文面の作成
- GitHub feedback を読んで要変更かを決める判断
- escalation 要約の作文

これだけで、いずれも**低頻度かつ stateless**。rework(`address review #<id>`)、merge conflict
(固定 note)、out-of-band review は既にテンプレートであり、人間の追加指示は原文 pass-through で
足りる。cost 確認は Inbox / Web UI の human 対話に置き換えられる(LLM は仲介していただけ)。

したがって resident な LLM parent を持つ理由がなくなる。orchestration は worker
(既に shared events を tail している)の決定的 loop + core の `reconcile()` になり、上記 3 つは
worker からの **one-shot LLM 呼び出し**(質問 1 つ、状態なし、都度起動)に置き換わる。
long-running な parent session の context / cache コストも消える。

- **段階**: (1) LLM parent が next に従う(上記ドラフト)→ (2) worker が NL 不要 action を
  自動実行し、NL 必要時だけ LLM を呼ぶ hybrid → (3) 完全決定化 + one-shot LLM。
- **設計原則との整合**: LLM parent が担っていた「想定外状況への融通」は、決定的 parent では
  「可視な失敗 + escalation」に置き換わる。これは本 repo の
  「automatic recovery より visible errors、人間がリカバリする」という原則そのもの。
- **終端では parent contract 自体が消える(316 行 → 0)。** prompt として残るのは
  Execute / Verify の 2 つだけになり、orchestration ロジックは全量が unit test 可能になる。

LLM parent は、orchestration ポリシーが散文でしか記述できなかった時期の scaffolding だった、
という整理になる。ポリシーがコードで書ける程度に理解が固まった今、その席から退ける。

ただしこれは LLM の追放ではなく**配置換え**である。LLM が引き続き最適な席は人間との
インターフェイス — 人間の自由文指示をドメイン操作(deliver 文面、Issue 化)へ翻訳する方向と、
止まった run の履歴を人間が読める物語(escalation 要約、状況説明)へ要約する方向 — であり、
LoopHub の目的(最小の注意で人間が監督する)における監督面はまさにここ。誤りが安価な
communication に LLM を、誤りが高価な state transition にコードを置く、という配分になる。

各段階で「プロンプトから削った防御 → CLI の強制に置換されているか」を PR の
acceptance criteria に入れると、C で挙げた退行リスクを防げる。
