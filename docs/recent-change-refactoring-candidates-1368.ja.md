# 直近の変更から抽出したリファクタリング候補（Issue #1368）

**対象読者**: 次のリファクタリングを計画・レビューするLoopHub開発者。

**この文書で決めること**: 候補の効果と実施コストを比較し、最初に着手する候補を選ぶ。

## 調査範囲と方法

起票時点の `HEAD` である `32340fdfeca8fac6247df1a2360314e564e86b92` を終点に、
`HEAD~8..HEAD` の8コミットを調査した。始点側の除外コミットは
`8956048e8c29b4a41824d7b2e9af552193c13d30` である。

調査には次の一次情報を用いた。

- `git log -8 --stat`、`git show <commit>`、`git diff --numstat HEAD~8..HEAD`
- 現行のソースと同居テスト
- [AGENTS.md](../AGENTS.md) の「単純な正解を選ぶ」「エラーを可視化する」方針と、
  `cli/` を薄くしてオーケストレーションを `core/` に置く責務分離

8コミットの合計差分は48ファイル、3,265追加・645削除である。画像4件も含むため、
単純な行数だけではなく、同じ箇所が変更された回数、変更理由、テスト増加、呼び出し側が
知る必要のある規約を重視した。

### 用語

- **Herdr / pane / staging tab**: Herdrはagentのterminal workspaceを管理する外部ツール、paneは
  一つのterminal表示領域、staging tabはpane再配置中だけ使う一時tabを指す。
- **module / interface / seam**: moduleは一つの振る舞いを提供するまとまり、interfaceはcallerが
  知る必要のある利用規約、seamはinterfaceを置いて実装を差し替えられる箇所を指す。
- **session projection**: Herdrの実行状態とLoopHubのDB rowを、Web/CLIが読むsession表現へ変換する処理。
- **foreign pane**: 対象Workflowが所有せず、安全に再配置できないpane。

## 8コミットの主要変更

| コミット | 主な変更 | 主要な根拠 |
| --- | --- | --- |
| `32340fdf` (#1366) | push対象がないGitHub PRのボタンを無効化 | `pull-detail.tsx` +25/-24、同テスト +89/-11、`queries/pulls.ts` +9/-1 |
| `65cda7cf` (#1367) | Workflow pane再配置時に無関係なHerdr focusを奪わないよう修正 | `cli/commands/workflow.ts` +2/-8、`cli/workflow-start.test.ts` +61/-6 |
| `8968ece2` (#1361) | GitHubへpush済みのコミットをPR画面で表示 | `core/git.ts`、`core/serialize.ts`、pull service、PR詳細UIを横断 |
| `91ff179f` (#1332) | PRサイドバーをAgents/Workflow run中心に再編 | 24ファイル、+1,508/-329。terminal、Herdr agent、serializer、2つのWeb UIと各テストを横断 |
| `04b781ac` (#1349) | コミット単位の差分ダイアログを追加 | core git/pulls、RPC、query、PR詳細UIを横断して +520/-26 |
| `ad242a16` (#1347) | Notification CenterのClear all後にポップアップを閉じる | UIとテストの2ファイル、+7/-1 |
| `682fe5c2` (#1343) | PR画面にコミット履歴一覧を追加 | core git/serialize/pullsとPR詳細UI、+255/-2 |
| `2b4edef5` (#1333) | Herdr内で起票したIssueとpaneを関連付ける | CLI context、DB/store、issue serviceとテストを横断して +667/-258 |

## 変更傾向

### 1. PR詳細は直近変更の集中点

8コミット中5件が
[pull-detail.tsx](../web/src/components/pull-detail.tsx#L66) と
[pull-detail.test.tsx](../web/src/components/pull-detail.test.tsx#L204) を変更した。コミットごとの
churn合計は本体 +271/-78、テスト +396/-19 である。現行ファイルはそれぞれ1,490行と
1,933行で、テストは51件ある。

本体にはページの取得と構成に加えて、コミット一覧/差分ダイアログ
([L183](../web/src/components/pull-detail.tsx#L183))、ヘッダーとmerge操作
([L417](../web/src/components/pull-detail.tsx#L417))、GitHub export/push操作
([L619](../web/src/components/pull-detail.tsx#L619))、レビュー、ファイル差分/Markdown preview、
コメントが同居している。特に #1343 → #1349 → #1361 → #1366 は同じPR詳細の異なる
振る舞いを連続して拡張しており、今後も変更衝突と広いテストfixture更新が起きやすい。

### 2. Herdr/Workflowは「計画」と「副作用の実行」のseamが浅い

純粋な検証とgrid計画は既に
[workflow-pane-layout.ts](../core/terminal/workflow-pane-layout.ts#L96) にあり、10件の同居テストで
異物pane、旧形式名、配置順などを検証している。一方、CLI側の
[layoutWorkflowTabPanes](../cli/commands/workflow.ts#L189) は `pane list`、staging tab作成、pane移動、
`--no-focus`、staging tab削除という完全な順序規約を知っている。

`65cda7cf` は、その途中にあった `pane zoom --off` がHerdr 0.7.1では対象paneへfocusするため
削除し、CLI統合テストのfake Herdrにfocus状態の追跡を追加した変更である。つまり障害原因は
grid計算ではなく、呼び出し側へ漏れた副作用プロトコルだった。

### 3. terminal serviceは複数の独立した変更理由を抱える

[core/service/terminal.ts](../core/service/terminal.ts#L533) は1,613行で、agent起動、session一覧、
read/focus/input/kill、closed Issue/PRのcleanup、cost limit enforcementを同じ公開オブジェクトと
実装ファイルに持つ。#1332だけで +143/-27 となり、session一覧をWorkflow階層・usageで
enrichする変更が起動やcleanupの実装にも隣接した。

対応する [herdr-sessions-service.test.ts](../core/herdr-sessions-service.test.ts#L58) は2,127行、
36テストで、session projectionだけでなくagent操作、cleanup、`herdr.tree`、`herdr.focus`まで扱う。
これは一つの外部interfaceを保つ価値とは別に、内部実装のlocalityが失われている根拠である。

### 4. テスト追加量が実装追加量を上回るhotspotがある

#1332では `core/herdr-sessions-service.test.ts` に443行、#1343/#1349/#1361/#1366では
`pull-detail.test.tsx` に合計396行が追加された。回帰防止自体は有効だが、巨大fixtureと複数の
振る舞いが一つのtest moduleに集まるため、対象外のsetupまで理解・更新する保守コストが増える。

## 優先順位

| 優先 | 候補 | 期待効果 | 実施コスト | 判断 |
| ---: | --- | --- | --- | --- |
| 1 | Workflow pane layoutを深いmoduleにする | 高 | 中 | 実障害の原因だったfocus/順序規約を小さなinterfaceの内側へ隠せる。既存の純粋planとテストを再利用できる |
| 2 | PR詳細を振る舞い単位のmoduleへ分ける | 高 | 中 | 8件中5件が集中。最初にcommit history/diffを切り出せば範囲を限定できる |
| 3 | terminalの内部をsession projection・agent操作・maintenanceに分ける | 高 | 高 | localityは大きく改善するが、DB/Herdr/processの依存と回帰面が広いので段階化が必須 |
| 4 | hotspotごとにtest builderとtest moduleを局所化する | 中 | 低〜中 | fixture変更を減らせる。ただしproduction seamの整理と同時に行わないと、テストだけの抽象化になる |

## 候補の詳細

### 候補1: Workflow pane layoutを一操作に閉じ込める（最優先）

- **対象**: [core/terminal/workflow-pane-layout.ts](../core/terminal/workflow-pane-layout.ts)、
  [cli/commands/workflow.ts:164](../cli/commands/workflow.ts#L164)、
  [cli/workflow-start.test.ts:405](../cli/workflow-start.test.ts#L405)
- **観測した問題**: core moduleはparserとplanを返すだけで、CLIが安全な実行順、staging tab、
  `--no-focus`、失敗の可視化を再構成している。interfaceが実装とほぼ同じ知識量を要求する浅い
  moduleになっている。`65cda7cf` はこの漏れから起きたfocus回帰の直接的な証拠である。
- **期待効果**: `layoutWorkflowTab({ sessionName, tabId, runId }, herdr)` のような一操作を
  interfaceにし、list/create/move/closeの順序とfocus不変条件を実装へ隠す。CLIは成功/失敗を
  表示するだけになり、同じ不変条件を一箇所で検証できる。
- **想定リスク**: child agentの起動成功を先に記録してからlayout失敗を可視化する現行順序
  ([workflow.ts:559](../cli/commands/workflow.ts#L559)) を変えると、実在するsessionが未記録になる。
  また、例外を握りつぶしたりretryを追加するとAGENTS.mdの可視エラー方針を壊す。

#### 振る舞いを維持する段階的実施案

1. 現行のcore planテストとCLI統合テストをcharacterization testとして固定し、単一pane、異物pane、
   不正JSON、Herdr非zero、無関係focus維持を明示する。
2. `workflow-pane-layout.ts` 内にHerdr command runnerを受け取る内部seamを置き、production adapterと
   deterministic fakeの2つを用意する。外部interfaceはlayout一操作と結果/エラーだけにする。
3. CLIの `runHerdrPaneLayoutCommand` と `layoutWorkflowTabPanes` の実装を新moduleへ移し、
   `confirmStepLaunch` → layoutの順序、コマンド列、timeout、エラーメッセージを維持する。
4. CLIを新interfaceの呼び出しと表示だけに置き換え、旧実装を削除する。自動cleanup、retry、focus復元
   などの新しい防御機構は追加しない。
5. moduleのinterfaceを通るテストが同じ振る舞いを覆った時点で、CLI fakeの実装詳細assertionを減らす。

#### テスト方針

- `core/terminal/workflow-pane-layout.test.ts`: command順序、全mutationの `--no-focus`、ratio、
  staging tabの作成/削除、1 paneのno-op、invalid/foreign paneの可視エラーをfake adapter経由で検証
- `cli/workflow-start.test.ts`: agent起動成功のconfirmがlayoutより先であること、layout失敗がnon-zeroに
  なること、無関係focusが不変であることをinterface越しに検証
- `npm test`、`npm run typecheck`、`npm run lint` を全体実行

### 候補2: PR詳細を振る舞い所有moduleへ分ける

- **対象**: [pull-detail.tsx](../web/src/components/pull-detail.tsx)、
  [pull-detail.test.tsx](../web/src/components/pull-detail.test.tsx)
- **観測した問題**: ページcomposition、commit diff、file diff、review grouping、merge/GitHub操作が
  同居し、5/8コミットが同じ本体/テストを変更した。51テストが一つの大きなRPC fixtureを共有する。
- **期待効果**: まず `PullCommitsSection` のような小さなinterfaceの内側にcommit選択、query、dialog、
  push badgeを隠す。その後、file diffやheader actionも振る舞い単位で移すと、変更と回帰テストの
  localityが上がる。
- **想定リスク**: JSXを別ファイルへ移すだけで多数のprops/helperを公開すると、浅いmoduleを増やす。
  dialogのEscape処理、React Query cache、file diff表示の再利用をinterface外へ漏らさない設計が必要。
- **根拠**: #1343/#1349/#1361/#1366の連続差分、現行の
  [CommitList](../web/src/components/pull-detail.tsx#L185) と
  [CommitDiffDialog](../web/src/components/pull-detail.tsx#L256)、51件の同居テスト。

### 候補3: terminalの外部interfaceを保ったまま内部moduleを深くする

- **対象**: [core/service/terminal.ts](../core/service/terminal.ts)、
  [core/herdr-sessions-service.test.ts](../core/herdr-sessions-service.test.ts)
- **観測した問題**: 起動、read/write/focus/kill、session projection、cleanup、cost stopという独立した
  変更理由が一実装に集まる。#1332のsession enrichmentだけで実装170行分のchurn、テスト443行追加。
- **期待効果**: 外部の `terminal` interfaceは維持しつつ、内部を `session catalog`、`agent control`、
  `maintenance` の責務に分ける。DB rowとHerdr出力からwire shapeを作る複雑さをsession catalogへ
  隠すと、web/workerのcallerを変えずにlocalityを得られる。
- **想定リスク**: storeやHerdr runnerを単に各fileへpass-throughするとinterfaceだけ増える。
  cleanupとcost stopはworkerの可視エラー/再実行規約に関わるため、最初は副作用の少ないsession
  projectionから移し、公開interfaceや失敗意味論を変えない。
- **根拠**: [terminalの公開操作](../core/service/terminal.ts#L533)、
  [session sweep](../core/service/terminal.ts#L1151)、
  [closed PR cleanup](../core/service/terminal.ts#L1406)、
  [cost enforcement](../core/service/terminal.ts#L1522) の離れた変更理由と、2,127行の同居テスト。

### 候補4: test fixtureをproduction seamに合わせて局所化する

- **対象**: `pull-detail.test.tsx`、`herdr-sessions-service.test.ts`、`cli/workflow-start.test.ts`
- **観測した問題**: recent changeの実装よりtest fixture拡張が大きく、無関係なRPC/Herdr状態まで
  setupする必要がある。
- **期待効果**: production moduleのinterfaceごとにtest moduleを同居させ、wire object builderや
  fake Herdr adapterをそのfeature内で再利用する。変更対象のinterfaceに必要な値だけを指定できる。
- **想定リスク**: 先に汎用fixture frameworkを作ると、productionより複雑なテスト抽象化になる。
  候補1〜3のseamを作る時に、重複が実在する範囲だけを抽出する。
- **根拠**: #1332のHerdr sessionテスト +443、PR詳細テストの8コミット合計 +396/-19、
  #1367でfocus追跡のためfake Herdr自体を拡張した事実。

## 優先しないもの

- `core/serialize.ts` は1,842行だが、AGENTS.mdがwire shapeのsingle source of truthとして明示している。
  行数だけを理由に分割すると、同じwire知識が複数箇所へ戻るため優先しない。
- `pull-herdr-section.tsx` は #1332 で大きく変わったが、現行273行は「PRに属するagent hierarchyを
  表示・focusする」という一つの振る舞いにまとまっている。まずはその上流のsession projectionと
  pane layout protocolを深くする方が効果が高い。
- Notification Centerの変更は1行の状態遷移と局所テストで完結しており、直近変更を根拠にした
  リファクタリング対象にはしない。

## 結論

最優先はWorkflow pane layoutのdeepeningである。変更量最大のファイルを機械的に分割するのではなく、
実際にfocus回帰を起こした副作用プロトコルを一つの小さなinterfaceへ閉じ込められ、既存のpure planと
テスト資産を再利用できるため、効果対コストが最も高い。次にPR詳細のcommit slice、最後に高コストな
terminal内部分割を段階的に進めるのが安全である。
