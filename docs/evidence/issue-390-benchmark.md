# Issue #390 の I/O 移行ベンチマーク

## 比較条件

- before: `caeb342a312592697309f7263cc1c01629359bf8`
- after: `969546ae8ee7908adc51e063be7756a953333db5`（`d0ec48e2f9c825aba94f6836ffc5f7f736d4d333` と `caeb342a312592697309f7263cc1c01629359bf8` の二親マージ後の証跡更新）
- コマンド: `bun scripts/benchmark-file-io.ts --before-ref caeb342a312592697309f7263cc1c01629359bf8 --trials 10`
- 環境: Bun 1.3.14、macOS arm64、8 logical CPUs、同じ現行 `node_modules`、独立した Bun worker process
- 測定方法: warm-up を含む build skip、dist 未作成からの cold rebuild、2 MiB payload の HTTP upload/save path と streaming GET path を各10試行。wall-clock と RSS は各 worker で測定し、表は中央値と min–max。メモリの主指標は1msサンプリング中の peak RSS とした。
- payload: 2097152 bytes、全試行の SHA-256 `e609118bb7a5a46616cf9c9e5c32728012b142d413d49bed22363bc4a9dc14dc`

## 結果

| 測定 | before median (range) | after median (range) | median 差 |
| --- | ---: | ---: | ---: |
| build skip wall | 10.672ms (8.903–44.753) | 8.706ms (6.417–20.710) | -18.4% |
| build skip peak RSS | 693.281MiB (682.844–694.953) | 683.734MiB (673.563–688.781) | -1.4% |
| cold rebuild wall | 2010.637ms (972.111–3840.670) | 1367.377ms (1180.006–1597.526) | -32.0% |
| cold rebuild peak RSS | 697.141MiB (673.156–705.078) | 687.813MiB (674.547–699.719) | -1.3% |
| attachment upload wall | 11.155ms (9.887–15.353) | 10.365ms (10.166–11.558) | -7.1% |
| attachment upload peak RSS | 134.094MiB (130.859–135.281) | 128.688MiB (124.828–129.969) | -4.0% |
| attachment download wall | 3.326ms (2.644–5.650) | 2.681ms (2.547–5.296) | -19.4% |
| attachment download peak RSS | 141.609MiB | 134.844MiB | -4.8% |

## 同一性と判断

- before / after の正規化 artifact digest は `2f102071da93aa119b6a37417f612757f2fbfd48a7fdbe254319a4dedaf5859b` で一致した。
- before / after の `.build-hash` は `20a6716a8742597d4169ba6232404f688da2265c3abce23f9e7f659eb9481eb6` で一致した。
- attachment の全試行で received bytes は `2097152`、received SHA-256 は expected SHA-256 と一致した。
- hash input は `Bun.file().bytes()` の bounded sliding window（同時実行数16）で読み取り、hash への投入順は sorted path 順で固定した。全入力を保持する `Promise.all` は peak RSS が約15MiB増えたため採用していない。
- HTTP ベンチマーク helper は #393 の Bun.serve API に合わせ、`server.url.origin` と `server.stop(true)` を使うよう更新した。添付 upload は実際の `saveAttachment` 経路、download は `Response(Bun.file(path))` 経路を通している。
- 今回の固定10試行では build skip、cold rebuild、attachment upload、download の wall median と peak RSS はすべて after が低下し、中央値ベースの非回帰を確認した。ranges は環境ノイズを含み、cold rebuild と skip の range は広いため、中央値だけを根拠に過度な精度は主張しない。
- attachment の RSS delta は before `+12.016MiB`、after `+13.609MiB` と増えたため、全メモリ指標が改善したとは主張しない。主指標である absolute peak RSS は upload / download とも低下した。
- 生成物・hash・payload の同一性、build/attachment の中央値 wall、主指標 peak RSS について、今回の pinned benchmark は非回帰を示した。詳細な範囲と RSS delta の増加もこの記録に残している。
