# Breaking changes

## 2026-07-11: event delivery interface の整理

Issue #1191 で次の公開 interface を削除した。

- `GET /events` は廃止され、現在は HTTP 410 を返す。Web UI は `events/list` JSON-RPC を polling する。
- `events/notify` capability / contract metadata は削除した。`events/list` の response shape は維持する。
- `lh events --follow` / `lh events -f` は削除した。旧 flag は snapshot に silent fallback せず終了 status 2 で拒否する。bounded polling には `lh events --since <id> --order asc --json` を使う。
- lh-web の `--poll-ms` / `LOOPHUB_POLL_MS` は削除した。これらは lh-web の旧 event delivery loop 専用だった。
- lh-worker の `--poll-ms` / `LOOPHUB_POLL_MS` は resident event dispatch に必要なため維持する。

旧 follow 利用者は、consumer ごとに cursor を保存して bounded snapshot を反復する。全履歴を
処理する場合は `0` から始め、再起動時は保存済み cursor を読む。各 response を id 昇順に処理して
最後の id を atomic に保存し、100 件返った場合は backlog を drain するため sleep せず次を取得する。

```sh
cursor="$(load_saved_cursor_or_echo_0)"
while true; do
  batch="$(lh events --since "$cursor" --order asc --repo owner/repo --json)"
  count="$(jq 'length' <<<"$batch")"
  if (( count > 0 )); then
    process_batch_in_order "$batch"
    cursor="$(jq 'map(.id) | max' <<<"$batch")"
    save_cursor_atomically "$cursor"
  fi
  (( count == 100 )) || sleep 2
done
```

上記の `load_*` / `process_*` / `save_*` は consumer 側で実装する placeholder である。

永続 `events` table と event id、worker cursor、`events/list`、通常の `lh events` snapshot に schema / data migration はない。
