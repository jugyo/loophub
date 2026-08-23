# テストスイート棚卸し

## コマンドと境界

- `npm test`: 日常的に実行する高速テスト。実 git リポジトリ、commit、branch、worktree を
  作成・操作するテストを除外する。
- `npm run test:integration`: 上記の実 git 統合テストだけを実行する。
- `npm run test:full`: 高速テストと実 git 統合テストを一度に実行する。CI や変更完了時の確認に使う。

統合テストの対象は `test-files.ts` の `gitIntegrationTestFiles` に明示する。ファイル名を
一括変更せず、既存テストへの参照や履歴を保ったまま境界をレビュー可能にしている。実 git を使う
テストを追加した場合は、この一覧にも追加する。

## 変更前の Vitest baseline

runner を変更する前の正確な baseline は、#389 の Bun lockfile/install setup を含む commit
`caeb342a312592697309f7263cc1c01629359bf8` を一時 checkout し、Bun 1.3.14 上の Vitest
2.1.9 で同じホストから連続して実行して採取した。ファイル集合は root の
`vitest.shared.ts` / `vitest.full.config.ts` の include と exclude、Web の
`web/vitest.config.ts` の `src/**/*.test.{ts,tsx}` で固定される。したがって baseline の
exact な対象は次の通りであり、ファイルを削除・skip して件数を合わせてはいない。

| Vitest config | ファイル | tests | 結果 |
| --- | ---: | ---: | --- |
| root fast (`vitest.config.ts`) | 117 | 1017 | 1017 passed / 0 failed |
| root full (`vitest.full.config.ts`) | 171 | 1863 | 1863 passed / 0 failed |
| Web (`web/vitest.config.ts`) | 93 | 1222 | 1222 passed / 0 failed |

対象ファイルの再現可能な exact manifest は、baseline commit 上で次の include を sorted に
展開したものとした。

```sh
git ls-tree -r --name-only caeb342a312592697309f7263cc1c01629359bf8 \
  | rg '(^vitest\.config\.test\.ts$|^scripts/.+\.test\.ts$|^core/.+\.test\.ts$|^cli/.+\.test\.ts$|^web/server/.+\.test\.ts$|^worker/.+\.test\.ts$)'
git ls-tree -r --name-only caeb342a312592697309f7263cc1c01629359bf8 \
  | rg '^web/src/.+\.test\.(ts|tsx)$'
```

Vitest の root fast / full / Web の実測はそれぞれ `12.40s / 69.41s / 31.18s`、peak RSS は
`935,149,568 / 922,697,728 / 733,380,608` bytes だった。

## 変更前の計測と低速群

移行前の計測は 2026-07-23 に Node.js 22.12.0、Vitest 2.1.9、`minWorkers: 1` / `maxWorkers: 4` で、
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
変更後の Bun test 群を、Bun 1.3.14、`--isolate`、同一ホストで連続して計測した。テスト対象は
`test-files.ts` の include と分類を使い、DB と real-git の前提を保つ。

| コマンド | ファイル | tests | wall time | peak RSS | 結果 |
| --- | ---: | ---: | ---: | ---: | --- |
| `bun scripts/test.ts fast` | 117 | 1018 | 30.66s | 1,111,474,176 | 成功 |
| `bun scripts/test.ts integration` | 54 | 846 | 178.12s | 1,351,925,760 | 成功 |
| `bun scripts/test.ts full` | 171 | 1864 | 221.71s | 2,141,945,856 | 成功 |
| `npm run test:web`（bounded batch） | 93 | 1222 | 72.71s | 3,222,700,032 | 成功 |

cold start の代表値（root は `core/config.test.ts` 14 tests、Web は `ui-catalog` 2 tests、
いずれも process 起動込み）は次の通りだった。

| suite | Vitest cold | Bun cold |
| --- | --- | --- |
| root | 0.37s / 126,713,856 bytes | 0.07s / 39,108,608 bytes |
| Web | 0.91s / 182,910,976 bytes | 0.34s / 171,540,480 bytes |

Web の初期 file-by-file isolation は 110.06s / 3,222,061,056 bytes だった。最終 runner は
通常 file を 8 file、`pull-detail.test.tsx` を 4 test-name、`pull-diff-dialog.test.tsx` を
1 test-name 単位の bounded batch とし、全 1222 tests を維持したまま 72.71s まで短縮した。
Vitest の 31.18s / 733,380,608 bytes と比べると、最終 Web は全体時間・peak RSS ともに改善
していない。これは Bun/JSC と happy-dom の DOM heap 累積および一括実行時の SIGTRAP を避ける
ための isolation コストであり、性能改善とは表現しない。代わりに、bounded isolation、failure
exit code の伝播、zero-suite 検出という保守性と失敗可視性を確保した。

意図的な failure fixture は `0 pass / 1 fail` かつ exit 1、root runner の空ディレクトリは
`no test files discovered` かつ exit 1、Web runner の空ディレクトリは
`no Web test files discovered` かつ exit 1 となった。通常の final suite はすべて 0 failures。
`npm run lint` と `npm run typecheck` も成功し、
`git merge-base --is-ancestor b1c0b7ed0f23517411f9d321422bf20716ce6223 HEAD` は成功した。

Bun test は bounded batch 内でも各ファイルに `--isolate` を使い、異なるファイルの
import-time DB 設定や DOM 状態が干渉しないようにしている。失敗した child の stdout/stderr と
非ゼロ exit code はその場で親 runner へ伝播するため、summary なしの成功は受け付けない。
