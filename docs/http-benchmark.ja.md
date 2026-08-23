# lh-web HTTP transport benchmark

## Environment and method

macOS arm64、Bun 1.3.14、同じ依存関係で、baseの`node:http`実装と今回の`Bun.serve`実装を同じBunランタイムで比較した。
各実装について、起動はserver生成からport 0のbind完了まで、RPCは`POST /rpc`の`initialize`、静的配信は
`GET /index.html`のレスポンスを読み終えるまでを測定した。起動は40サンプル、RPCと静的配信は5回warm-up後に
各40サンプルとし、中央値とp95を記録した。中央値はソート済み`v[19]`と`v[20]`の平均、p95はnearest-rank
定義の`v[ceil(0.95*n)-1]`（40件では`v[37]`）とする。

## Reproduction

repository rootで、base sourceを一時展開し、次のコマンドを実行する。`BENCH_CODE_ROOT`だけを切り替えて、
同じ測定コードを`node:http`（base source）と`Bun.serve`（current source）に適用する。

```sh
benchmark_root=$(mktemp -d /tmp/loophub-http-benchmark.XXXXXX)
trap 'rm -rf "$benchmark_root"' EXIT
git archive 4c73738f077b2f48488679dccd493a978079aff2 | tar -x -C "$benchmark_root"
ln -s "$PWD/node_modules" "$benchmark_root/node_modules"
ln -s "$PWD/web/node_modules" "$benchmark_root/web/node_modules"

for benchmark_mode in node bun; do
  if [ "$benchmark_mode" = bun ]; then benchmark_code_root="$PWD"; else benchmark_code_root="$benchmark_root"; fi
  BENCH_MODE="$benchmark_mode" BENCH_CODE_ROOT="$benchmark_code_root" bun -e '
    const fs = await import("node:fs"), path = await import("node:path");
    const mode = process.env.BENCH_MODE, root = process.env.BENCH_CODE_ROOT;
    const home = fs.mkdtempSync(path.join("/tmp", "loophub-http-home-"));
    const dist = path.join(home, "dist"); fs.mkdirSync(dist, { recursive: true });
    fs.writeFileSync(path.join(dist, "index.html"), "bench");
    process.env.LOOPHUB_HOME = home; process.env.LOOPHUB_DB = path.join(home, "bench.db"); process.env.LOOPHUB_WEB_DIST = dist;
    const http = await import(root + "/web/server/http.ts");
    const payload = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const stats = (v) => { v.sort((a, b) => a - b); const middle = v.length / 2; const median = v.length % 2 ? v[Math.floor(middle)] : (v[middle - 1] + v[middle]) / 2; const p95 = v[Math.ceil(0.95 * v.length) - 1]; return { median_ms: +median.toFixed(3), p95_ms: +p95.toFixed(3), samples: v.length }; };
    const start = async () => { const t = performance.now(); let s, base;
      if (mode === "bun") { s = http.createLhWebServer(); base = s.url.origin; }
      else { s = http.createLhWebServer(); await new Promise(r => s.listen(0, "127.0.0.1", r)); base = "http://127.0.0.1:" + s.address().port; }
      return { s, base, startup: performance.now() - t }; };
    const stop = (s) => mode === "bun" ? s.stop(true) : new Promise((r, j) => s.close(e => e ? j(e) : r()));
    const startup = []; for (let i = 0; i < 40; i++) { const x = await start(); startup.push(x.startup); await stop(x.s); }
    const x = await start(); for (let i = 0; i < 5; i++) { await fetch(x.base + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: payload }).then(r => r.arrayBuffer()); await fetch(x.base + "/index.html").then(r => r.arrayBuffer()); }
    const rpc = [], staticServing = []; for (let i = 0; i < 40; i++) { let t = performance.now(); await fetch(x.base + "/rpc", { method: "POST", headers: { "content-type": "application/json" }, body: payload }).then(r => r.arrayBuffer()); rpc.push(performance.now() - t); t = performance.now(); await fetch(x.base + "/index.html").then(r => r.arrayBuffer()); staticServing.push(performance.now() - t); }
    await stop(x.s); console.log(JSON.stringify({ runtime: "Bun " + Bun.version, implementation: mode === "bun" ? "Bun.serve" : "node:http", startup: stats(startup), rpc: stats(rpc), static: stats(staticServing) }));
  '
done
```

## Result

実行日は2026-08-23。測定JSONは次のとおり。

```text
{"runtime":"Bun 1.3.14","implementation":"node:http","startup":{"median_ms":4.609,"p95_ms":12.074,"samples":40},"rpc":{"median_ms":0.979,"p95_ms":3.901,"samples":40},"static":{"median_ms":2.035,"p95_ms":12.818,"samples":40}}
{"runtime":"Bun 1.3.14","implementation":"Bun.serve","startup":{"median_ms":0.059,"p95_ms":2.939,"samples":40},"rpc":{"median_ms":0.771,"p95_ms":2.274,"samples":40},"static":{"median_ms":0.483,"p95_ms":5.344,"samples":40}}
```

| 実装 | 起動中央値 / p95 (ms) | RPC中央値 / p95 (ms) | 静的配信中央値 / p95 (ms) |
| --- | ---: | ---: | ---: |
| `node:http` | 4.609 / 12.074 | 0.979 / 3.901 | 2.035 / 12.818 |
| `Bun.serve` | 0.059 / 2.939 | 0.771 / 2.274 | 0.483 / 5.344 |

起動、RPC、静的配信の中央値・p95がすべてBun.serveで改善したため、性能回帰は確認されなかった。
