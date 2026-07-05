# Usage Sweep Evidence for Issue 748

Date: 2026-07-05

This note records the manual verification for PR #750 / issue #748. It is not
used by runtime code.

## Real-data usageSync timing

Command:

```sh
node --experimental-sqlite --disable-warning=ExperimentalWarning --import tsx --eval 'const s=await import("./core/service.ts"); for (const label of ["first","second","third"]) { const t=performance.now(); const r=s.sessions.usageSync(); console.log(JSON.stringify({label,ms:performance.now()-t,synced:r.synced,skipped:r.skipped,missing:r.missing,total:r.sessions.length})); }'
```

Output excerpt on the shared LoopHub data set:

```json
{"label":"first","ms":846.261834,"synced":2,"skipped":610,"missing":185,"total":797}
{"label":"second","ms":72.21966599999996,"synced":0,"skipped":612,"missing":185,"total":797}
{"label":"third","ms":56.185833,"synced":0,"skipped":612,"missing":185,"total":797}
```

The warmed unchanged resident-process calls were below 100ms with 797 agent
sessions.

## Live lh-web responsiveness

Command:

```sh
npm run lh-web -- --port 8732 --poll-ms 0 --usage-sweep-ms 1000
sleep 4
curl -fsS -w 'issue-page HTTP %{http_code} total=%{time_total}s\n' -o /dev/null http://localhost:8732/r/jugyo/loophub/issues/748
tmp=$(mktemp)
curl -fsS -w 'issues-get HTTP %{http_code} total=%{time_total}s\n' -o "$tmp" \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"issues/get","params":{"repo":"jugyo/loophub","number":748}}' \
  http://localhost:8732/rpc
jq -r '.result.title' "$tmp"
rm -f "$tmp"
```

Output excerpt after warm-up with usage sweep running every 1000ms:

```text
issue-page HTTP 200 total=0.003233s
issues-get HTTP 200 total=0.001686s
usage sweep のイベントループブロックを解消する（パース前スキップと rollout スキャン共有）
```

The in-app browser backend was unavailable in this session
(`agent.browsers.list()` returned `[]`), so this live check used the worktree
`lh-web` HTTP route and JSON-RPC endpoint.
