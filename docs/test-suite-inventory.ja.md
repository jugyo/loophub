# テストスイート棚卸し

## コマンドと境界

- `npm test`: 日常的に実行する高速テスト。実 git リポジトリ、commit、branch、worktree を
  作成・操作するテストを除外する。
- `npm run test:integration`: 上記の実 git 統合テストだけを実行する。
- `npm run test:full`: 高速テストと実 git 統合テストを一度に実行する。CI や変更完了時の確認に使う。

統合テストの対象は `vitest.shared.ts` の `gitIntegrationTestFiles` に明示する。ファイル名を
一括変更せず、既存テストへの参照や履歴を保ったまま境界をレビュー可能にしている。実 git を使う
テストを追加した場合は、この一覧にも追加する。

## 変更前の計測と低速群

2026-07-23 に Node.js 22.12.0、Vitest 2.1.9、`minWorkers: 1` / `maxWorkers: 4` で、
変更前の `npm test -- --reporter=json` を計測した。同じホストで別のテスト process が並行していた
ため wall time は 621.79 秒で、host 競合により 11 ファイルが timeout した。絶対値は安定した
ベンチマークとして扱えないが、ファイル別の主な低速箇所は次のとおりだった。

| テストファイル | 時間 | 主なコスト |
| --- | ---: | --- |
| `cli/workflow-start.test.ts` | 204.08 秒 | CLI subprocess、repository/worktree 作成 |
| `cli/issue-update.test.ts` | 162.99 秒 | CLI subprocess、repository/branch 操作 |
| `cli/pr-update.test.ts` | 123.68 秒 | CLI subprocess、commit/rebase 操作 |
| `cli/dev.test.ts` | 96.77 秒 | repository/worktree provision |
| `core/git.test.ts` | 93.96 秒 | 実 git command と worktree 操作 |
| `core/github-pull-service.test.ts` | 74.63 秒 | repository/branch/commit を使う service 統合 |
| `core/worktrees.test.ts` | 32.55 秒 | 実 worktree の作成・削除 |
| `worker/runner.test.ts` | 25.69 秒 | repository/worktree と worker 統合 |

実 git を使う 52 ファイルを統合テスト群に分類した。SQLite だけを使う service テストや純粋な
判定ロジックのテストは高速群に残した。

## 削除・統合の判断

棚卸しでは `allTestFiles` に一致する root の full suite 116 テストファイルを対象に、削除済み機能、
同じ公開振る舞いの重複検証、実装詳細だけを固定するテストがないかを確認した。今回削除または統合する
テストはない。低速テストは git/worktree の実経路や CLI 境界を検証しており、純粋な単体テストでは
置き換えられない重要な振る舞いを守っている。高速化のために検証を弱めず、実行頻度をコマンドで分ける。

## 変更後の比較

host 上の並行 test process の影響を抑えるため、変更前の単一スイートと同じ対象を読むフル群と
変更後の高速群を、同じ Node.js、Vitest、`maxWorkers=1` / `minWorkers=1`、同一ホストで連続して
計測した。フル群は変更前の `vitest.config.ts` と同じ include と worker 以外の設定を使う。

| コマンド | ファイル | tests | wall time | 結果 |
| --- | ---: | ---: | ---: | --- |
| `npm test -- --maxWorkers=1 --minWorkers=1` | 64 | 677 | 58.00 秒 | 675 passed、2 skipped |
| `npm run test:full -- --maxWorkers=1 --minWorkers=1` | 116 | 1310 | 267.56 秒 | 1308 passed、2 skipped |

高速群は変更前相当の全件より 209.56 秒、78.3% 短かった。最初の worker 4 個での計測では別
worktree の複数 Vitest process と競合して timeout が発生したため、短縮率には両方成功した
上記の同一 worker 条件だけを使用した。

最終検証では worker 上書きなしの `npm run test:full` も 115 files passed、1 skipped、
1308 tests passed、2 skipped、141.99 秒で成功した。`npm test`、`npm run typecheck`、
`npm run lint` も成功した。
