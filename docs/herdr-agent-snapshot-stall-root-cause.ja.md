# herdr agent snapshot 停止の調査結果

## Conclusion

- top-level `herdr session list` の起動失敗・非ゼロ終了は reject され、malformed output も `ServiceError` になる。正常な 0 件だけが `{ repos: [], running_repos: [] }` を返す。`core/terminal/herdr-cleanup.ts:29-37`
- top-level capture failure は last-known data に `session_list_capture_failed: true` を付けて保存する。この marker は構造 signature に含まれるため、最初の失敗と同一構造への回復がそれぞれ `terminal.sessions_updated` を emit する。`core/terminal/herdr-cleanup.ts:101-151`, `core/terminal/herdr-snapshot-signature.ts:44-52`
- per-repo capture failure は `capture_failed_repos` を設定し、last-known agents を `stale_since` 付きで保持する。`core/terminal/herdr-cleanup.ts:41-80`, `core/terminal/herdr-cleanup.ts:148-151`
- `/agents` は top-level または per-repo capture failure を confirmed-empty から除外する。fresh、`running_repos` が配列、failure なしの 0 件だけを `No herdr sessions with agents.` と表示し、それ以外の 0 件は `Agent information is unavailable.` と表示する。`web/src/components/agents-page.tsx:82-90`, `web/src/components/agents-page.tsx:102-138`
- usage transcript の同期は SQLite flags 付き CLI subprocess で実行され、parent worker は非同期に結果を待つ。heartbeat timer は parent worker で独立して動く。`worker/usage-sync.ts:8-44`, `worker/maintenance.ts:212-220`, `worker/maintenance.ts:366-429`
- usage sync の subprocess と worker は `SessionUsageSyncResult` と `SessionUsageSyncStatus` を共有する。`core/service/sessions.ts:51-68`, `worker/usage-sync.ts:1-12`, `worker/maintenance.ts:369-383`
- Web query の polling は追加していない。snapshot の構造変化が `terminal.sessions_updated` を emit し、既存 event mapping が共有 query を invalidate する。`core/terminal/herdr-cleanup.ts:101-120`, `web/src/lib/event-keys.ts:342-347`, `web/src/queries/terminal.ts:19-34`

## Tests

- top-level failure marker、重複 event の抑止、同一構造への回復 event を検証する。`core/terminal/herdr-snapshot.test.ts:103-130`
- malformed output が failure marker を設定し、正常な同一 empty snapshot への回復で marker を消すことを検証する。`core/herdr-sessions-service.test.ts:221-271`
- `/agents` が per-repo failure を confirmed-empty にせず、top-level failure では last-known agents を表示することを検証する。`web/src/components/agents-page.test.tsx:184-233`
- 60 秒を超えて usage sync が pending でも heartbeat が compatible のままであることを検証する。`worker/maintenance.test.ts:164-200`
- production と同じ subprocess が isolated DB で JSON result を返すことを検証する。`worker/usage-sync.test.ts:14-23`

引用した定義と test を特定する静的検査:

```sh
rg -n 'session_list_capture_failed|persistHerdrSnapshot|terminal.sessions_updated' core/terminal/herdr-cleanup.ts core/terminal/herdr-snapshot-signature.ts core/terminal/herdr-snapshot.test.ts core/herdr-sessions-service.test.ts
rg -n 'captureUnavailable|confirmedEmpty|Agent information is unavailable|No herdr sessions with agents' web/src/components/agents-page.tsx web/src/components/agents-page.test.tsx
rg -n 'SessionUsageSync(Status|Result)|runUsageSyncSubprocess|heartbeat stays fresh' core/service/sessions.ts worker/usage-sync.ts worker/maintenance.ts worker/maintenance.test.ts
```

Static citation result: passed
