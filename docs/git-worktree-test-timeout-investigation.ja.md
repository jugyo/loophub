# git / worktree 関連テストの timeout 調査

調査日: 2026-07-15

## 結論

断続的な timeout の主因は、実行が止まる Git command や repository lock ではなく、
Vitest worker と各 worker が起動する多数の Git / CLI subprocess による resource
contention である。高並列時には、個々は 1 秒未満で完了する Git command の待ち時間が
積み上がり、1 test の既定値 5 秒（個別指定がある test は 15 秒）を超える。

現行の `vitest.config.ts` にある `maxWorkers: 4` は、この原因に直接作用する妥当な第一対策で
ある。通常の 4-worker 全体実行は 3/3 成功し、20-worker 全体実行は 3/3 失敗した。timeout
値の一律引き上げや retry は、resource contention を隠して test suite をさらに重くするため
推奨しない。

同時に、`core/worktrees.test.ts` には、別々の Vitest process が同じ `TMPDIR` を共有すると
固定 sibling path が衝突する独立した race がある。この race は即時の Git error として再現し、
今回の 5 秒 timeout とは区別する必要がある。

## 対象と環境

- Host: macOS Darwin 25.5.0, arm64
- CPU: 10 physical / 10 logical cores
- Node.js: v22.12.0
- Git: 2.50.1 (Apple Git-155)
- Vitest: 2.1.9（`package-lock.json` に従った `npm install` 後）
- Test timeout: Vitest default 5 秒。一部の重い test は 15 秒を明示
- Temp directory: 反復ごとに専用 `TMPDIR` を作り、前回の中断が残した path を除外
- Database: 各 test file が `mkdtempSync()` で固有の `LOOPHUB_HOME` / `LOOPHUB_DB`
  を設定するため、通常の 1 suite 内で worker 間に SQLite DB の共有はない

調査開始時点の `main` には、別変更に含まれた `minWorkers: 1, maxWorkers: 4` が既に存在した。
この調査では CLI の `--minWorkers` / `--maxWorkers` で並列度だけを変更し、現行設定と
上限なし相当の負荷を比較した。製品コード、test timeout、retry は変更していない。

## 再現手順

最初に依存関係を導入する。

```sh
npm install
```

単体条件は Git helper と worktree service の 2 file を 1 worker で反復する。

```sh
for i in {1..10}; do
  run_tmp=$(mktemp -d "/tmp/lh-timeout-target-${i}.XXXXXX")
  TMPDIR="$run_tmp" npm test -- \
    core/git.test.ts core/worktrees.test.ts \
    --maxWorkers=1 --minWorkers=1 --reporter=basic
  rm -rf "$run_tmp"
done
```

全体条件は worker 数だけを変えて反復する。現象を高確率で再現するには 10-core host で
20 worker を指定する。

```sh
for workers in 4 10 20; do
  for i in 1 2 3; do
    run_tmp=$(mktemp -d "/tmp/lh-timeout-${workers}w-${i}.XXXXXX")
    TMPDIR="$run_tmp" npm test -- \
      --maxWorkers="$workers" --minWorkers="$workers" --reporter=basic
    rm -rf "$run_tmp"
  done
done
```

固定 temp path の独立した race は、同じ `TMPDIR` で 2 process を同時起動すると再現する。

```sh
run_tmp=$(mktemp -d /tmp/lh-collision.XXXXXX)
TMPDIR="$run_tmp" npm test -- core/worktrees.test.ts \
  --maxWorkers=1 --minWorkers=1 &
TMPDIR="$run_tmp" npm test -- core/worktrees.test.ts \
  --maxWorkers=1 --minWorkers=1 &
wait
rm -rf "$run_tmp"
```

## 基準データ

### 対象 file の単体反復

`core/git.test.ts` と `core/worktrees.test.ts` を 1 worker で 10 回実行した。

| 指標 | 結果 |
| --- | --- |
| 成功 | 10/10 run |
| Test | 各 run 24/24、合計 240/240 |
| Timeout | 0 |
| Duration | 6.11–7.76 秒、中央値 6.55 秒、平均 6.71 秒 |

各 run の duration は 6.35, 7.41, 6.74, 6.26, 6.32, 6.18, 6.11, 7.10,
6.88, 7.76 秒だった。file 全体は 5 秒を超えるが、個別 test は閾値内である。

### 全体実行の worker 数比較

| Worker | 成功 run | Timeout 数 / run | Wall duration / run | Vitest の総 test time / run |
| ---: | ---: | --- | --- | --- |
| 4 | 3/3 | 0, 0, 0 | 62.74, 60.49, 55.36 秒 | 200.37, 189.39, 168.91 秒 |
| 10 | 3/3 | 0, 0, 0 | 54.83, 75.50, 78.41 秒 | 397.63, 458.23, 539.20 秒 |
| 20 | 0/3 | 5, 6, 3 | 60.77, 59.62, 51.96 秒 | 777.92, 804.63, 648.86 秒 |

全 run は 96 test files / 1148 tests を収集した。wall duration はホスト上の他負荷にも左右
されるため、原因判定には並列に実行された各 worker の時間を足した「総 test time」と timeout
率を用いた。4 から 20 worker への増加で総 test time は約 3.2–4.3 倍になり、20 worker では
毎回 timeout した。

20-worker run で停止位置として報告された test は次の通りである。

| Test | 発生 run | 観測時間 |
| --- | --- | --- |
| `core/worktrees.test.ts > plan classifies done/open/dirty/missing/cwd worktrees` | 3/3 | 5.013–5.026 秒 |
| `core/worktrees.test.ts > remove deletes a clean worktree; tidy prunes admin entries` | 1/3 | 5.061 秒 |
| `core/notifications-service.test.ts > read marks a notification without removing it from the persisted list` | 3/3 | 5.007–5.038 秒 |
| `core/notifications-service.test.ts > human-attention backfill follows the latest substantive review` | 2/3 | 5.007–5.053 秒 |
| `core/notifications-service.test.ts > merge-ready notifications follow clean transitions without sweep duplicates` | 2/3 | 15.964–16.593 秒（15 秒指定） |
| `core/github-pull-service.test.ts > pushGithubPull pushes the head...` | 2/3 | 6.618–6.789 秒 |
| `core/attempt-supersede.test.ts > merging an attempt closes open siblings...` | 1/3 | 6.100 秒 |

停止位置は run ごとに変わる一方、いずれも多数の repository 操作を含む integration test で、
timeout 値をわずかに超えている。特定 command で常に停止する hang の形ではない。

### 過去 run の記録

既存の Workflow artifact にも同じ傾向がある。

- Run 67: 全体並列実行で 5 個の Git / DB test files にまたがり 10 tests が timeout。
  `core/worktrees.test.ts`, `core/attempt-supersede.test.ts`,
  `core/github-merge-sync.test.ts`, `core/github-pr-status-service.test.ts`,
  `core/pull-merge-no-commits.test.ts` を 1 worker で再実行すると 21/21 tests が成功した。
  記録: `~/.loophub/runs/workflow/67/verify/input/report.md`
- Run 49 / 50: `cli/dev.test.ts` の同一 build test が全体実行では繰り返し 5 秒 timeout。
  単体実行は 2.847 秒で成功した記録と 5.332 秒で失敗した記録があり、処理時間が閾値に
  近いとホスト負荷だけで結果が反転することを示す。
  記録: `~/.loophub/runs/workflow/{49,50}/verify/input/prior-verdicts.md`

## 切り分け

### Git subprocess: 個別 hang ではない

一時的に `PATH` の先頭へ trace wrapper を置き、各 Git command の開始時刻、終了時刻、PID、
終了 code、経過時間を記録した。同じ wrapper による相対比較結果は次の通りだった。wrapper の
追加コストがあるため、通常実行の絶対時間とは混ぜない。

| Worker | Git start / end | 平均 | 最大 | 1 秒以上 | Test 結果 |
| ---: | ---: | ---: | ---: | ---: | --- |
| 4 | 5096 / 5096 | 0.0345 秒 | 0.6012 秒 | 0 | 1148/1148 成功 |
| 20 | 5101 / 5101 | 0.0850 秒 | 0.8885 秒 | 0 | 5 timeout |

20 worker では 1 command も 1 秒を超えず、開始だけで終了がない command も、run 終了後に
残った Git process もなかった。一方で平均 Git command 時間は 4 worker の約 2.46 倍、
総 test time は 310.14 秒から 656.84 秒へ約 2.12 倍になった。従って Vitest が報告した
「停止箇所」は、1 command の hang ではなく、その test が完了を待っていた時点である。

`core/git.ts` の `git()` は `execFile()` に subprocess timeout を設定していないため、本物の
Git hang が起きた場合に Vitest の test timeout だけでは child の原因を説明しにくい余地はある。
ただし今回の trace は全 child の正常終了を確認しており、この設計は今回の根本原因ではない。

### worktree 作成・削除: command 数の累積

最頻出の `plan classifies...` は 1 test 内で repository の init/config/commit に加え、5 個の
worktree add、各 worktree の status/list、5 個の remove を直列に実行する。通常の全体実行では
607 ms、20 worker では毎回 5.013–5.026 秒となり、同じ処理が約 8 倍以上に伸びた。

別々の repository を使うため repository lock の共有はない。trace 中の command も全て 1 秒未満
で完了したため、worktree add/remove 固有の hang ではなく command 数が多い test が負荷の影響を
先に受けると判断できる。

### temp directory: 独立した path collision がある

`makeRepo()` 自体は `mkdtempSync()` で固有 path を作るが、worktree はその parent に
`wt-${repo.id}-${n}` などの固定名で作られる。同じ `TMPDIR` を使う 2 process は別 DB でも
同じ `repo.id` から同じ sibling path を選ぶ。

2 process の同時実行を 3 回反復すると、全 3 run で少なくとも一方が失敗し、2 run では両方が
失敗した。代表的な error は次の通りで、2.18–2.77 秒で明示的に失敗した。

```text
fatal: '/tmp/.../wt-1-1' already exists
fatal: Unable to create '.../.git/worktrees/wt-1-1/index.lock': File exists.
fatal: not a git repository: .../.git/worktrees/wt-1-1
```

これは concurrent suite process 間の実 race だが、高 worker の単一 suite で観測した 5 秒
timeout とは symptom も原因も異なる。反復ごとに専用 `TMPDIR` を使用した 20-worker 計測でも
timeout は 3/3 で発生したため、path collision を除去しても主現象は残る。

### SQLite と test 間状態

各 test file は import 前に固有 `LOOPHUB_HOME` と DB path を作るため、worker 間で SQLite file
や `busy_timeout` を共有しない。DB lock を示す error も観測しなかった。

ただし同一 file 内では fixture と DB を複数 test で共有する。例えば
`core/notifications-service.test.ts` は先行 test が作った PR を後続の `list()` / sweep が再評価
するため、後続 test も複数の Git query を実行する。この累積状態により「read」のような短く
見える test も高負荷時に 5 秒へ達するが、test file 内は逐次実行なので race ではない。

## 原因判定

| 候補 | 判定 | 根拠 |
| --- | --- | --- |
| 過剰な worker / subprocess による resource contention | 根本原因 | 4 worker 0/3 失敗、20 worker 3/3 失敗。Git 平均時間 2.46 倍、総 test time 2.12 倍 |
| 1 個の Git subprocess の hang | 否定 | 20-worker trace 5101/5101 終了、最大 0.8885 秒、残存 process なし |
| 同一 repository の Git lock 競合 | 主現象では否定 | 通常 suite は repository を分離し、lock error なし |
| SQLite file の worker 間共有 | 否定 | test file ごとに固有 DB、DB lock error なし |
| 固定 worktree temp path の process 間 race | 別件として確認 | concurrent process で 3/3 再現。ただし即時 Git error であり、専用 `TMPDIR` の単一 suite timeout とは別 |
| timeout 閾値が単に短い | 二次要因 | 高負荷時だけ 5 秒を僅かに超える。低並列 10/10 成功のため閾値だけの問題ではない |

## 対策案

### 優先度 1: 現行の 4-worker 上限を維持する（推奨）

- 効果: 高い。今回の全体反復 3/3 と trace 実行 1/1 が成功した
- 実装コスト: なし。`vitest.config.ts` に既に存在する
- リスク: CPU core が多い host で、競合が少ない test だけを見れば wall time が伸びる可能性が
  ある。一方、失敗後の再実行を含む総所要時間と可視性は改善する
- 理由: 原因である同時 worker / subprocess 数を直接制限し、test timeout や retry で失敗を
  隠さない

### 優先度 2: worktree fixture path を process 固有にする（別 follow-up）

- 効果: 中。複数の `npm test` process が同じ host / `TMPDIR` で走る際の path collision を除く
- 実装コスト: 低。`repo.id` だけでなく、`makeRepo()` が返した固有 repository path または
  file 固有 HOME 配下に worktree を置く
- リスク: 低。production の worktree 規約ではなく test fixture のみを変更する
- 注意: resource contention timeout の主対策ではないため、worker 上限の代替にはしない

### 優先度 3: 重い integration test の fixture/state を局所化する

- 効果: 中。1 test の Git command 数と、同一 file の先行 test が後続 test へ与える累積コストを
  減らせる
- 実装コスト: 中～高。coverage を維持した fixture 分割と test seam の見直しが必要
- リスク: 過度な mock 化で実 Git / worktree behavior の回帰検出力を落とす可能性がある
- 方針: まず `core/notifications-service.test.ts` の shared repository/state と、
  `core/worktrees.test.ts` の複数 worktree setup を計測可能な小さい fixture に分ける

### 優先度 4: subprocess hang の診断性を別途改善する

- 効果: 今回の timeout にはなし。本物の Git hang が将来起きた場合の停止 command を明確にする
- 実装コスト: 中。production の `git()` に一律 timeout を足すと長い正常操作を誤って kill する
  ため、test harness の trace または用途別 deadline が必要
- リスク: production behavior を変える一律 timeout は高い
- 方針: 今回の対策としては実装せず、実 hang の証拠が出た場合に限定して検討する

### 非推奨: 一律 timeout 引き上げ / retry

20 worker では 15 秒指定の test も timeout し、総 test time が最大 804.63 秒まで増えた。
閾値を 5 秒から 15 秒へ一律変更しても contention を減らさず、さらに悪い負荷で同じ問題を
先送りする。retry は同じ host 負荷へ subprocess を追加し、初回失敗を不安定に見えなくする。

特定 test の低並列時 p99 が 5 秒へ近づくという新しい計測結果が得られた場合のみ、処理の
削減後にその test 個別の timeout を検討する。その際も「低並列 30 回の p99 に安全率を掛ける」
などの根拠を記録し、一律設定にはしない。

## 回帰テストと改善確認

推奨案を維持・実装する際は、次を同じ commit で実行する。

1. `npm test` を現行設定で 3 回実行し、全 run が成功することを確認する。
2. `core/git.test.ts core/worktrees.test.ts` を 1 worker で 10 回反復し、240/240 tests が成功し、
   個別 test timeout がないことを確認する。
3. CI または同一 host で複数 test process を動かす運用では、run ごとに固有 `TMPDIR` を設定する。
4. 優先度 2 の path 修正時は、同じ `TMPDIR` で 2 個の `core/worktrees.test.ts` process を
   同時起動し、3/3 pair（合計 6/6 process）が成功することを回帰条件にする。
5. worker 上限変更を検討する場合は、4 / 候補値で全体を各 3 回計測し、timeout 数、wall time、
   Vitest 総 test time をこの文書と同じ形式で比較する。1 回の成功だけでは上限を緩めない。

負荷再現用の 20-worker run は原因確認には有用だが、意図的に失敗率を上げる stress test であり、
通常 CI の pass 条件にはしない。通常 CI は 4-worker 上限と固有 temp path で安定性を確認する。
