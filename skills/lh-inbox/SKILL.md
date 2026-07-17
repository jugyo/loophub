---
name: lh-inbox
description: >-
  Send, inspect, and update LoopHub Inbox messages. Use when the user asks to use
  `lh inbox`, send a message to a human or agent, check unread Inbox messages, or
  mark Inbox messages read, unread, archived, unarchived, or deleted.
---

# LoopHub inbox

Use LoopHub Inbox for short human-facing or agent-facing messages tied to a LoopHub repository.
This skill covers existing Inbox operations only; do not add or change `lh inbox` command behavior.

## Prerequisites

- **Server**: default `http://localhost:8730`; resolve it with `lh info --json | jq -r .baseUrl`.
- **CLI**: `lh` on PATH.
- **RPC tools**: `jq` and `curl` for listing/fetching Inbox messages through the web API.
- **Repository**: use `--repo owner/name` when outside the registered repo root and outside a
  LoopHub worktree (worktree cwd is inferred by `resolveRepo()`).
- **Session**: agents must set `SESSION_ID` to their registered LoopHub session id before CLI state
  changes. If `SESSION_ID` is empty, stop and resolve the agent session first; omitting `--session-id`
  intentionally attributes the write to the default persisted human CLI session.
- **Sender**: `--from` must be a JSON object. Its `repo` must match the target repo.
- **Recipient**: `--to` is optional JSON; omit it for general repo Inbox messages.

Common sender shapes:

```sh
FROM_AGENT='{"kind":"agent","repo":"owner/repo","actor":"impl-bot"}'
FROM_TASK='{"kind":"scheduled_task","repo":"owner/repo","task_id":12,"run_id":34}'
```

Common recipient shapes:

```sh
TO_HUMAN='{"kind":"human"}'
TO_AGENT='{"kind":"agent","repo":"owner/repo","actor":"reviewer-bot"}'
```

Agent session guard:

```sh
test -n "${SESSION_ID:-}" || { echo "SESSION_ID is required for agent-attributed Inbox writes" >&2; exit 1; }
```

## Send a message

Use `lh inbox send`. Prefer stdin for multiline bodies so shell quoting stays simple.

```sh
FROM_AGENT='{"kind":"agent","repo":"owner/repo","actor":"impl-bot"}'
TO_HUMAN='{"kind":"human"}'

printf '%s\n' '<message body>' |
lh inbox send \
  --repo owner/repo \
  --from "$FROM_AGENT" \
  --to "$TO_HUMAN" \
  --label review \
  --title '<short title>' \
  --body -
```

Add `--json` when you need the created message id, state, or serialized fields for a follow-up step:

```sh
printf '%s\n' '<message body>' |
lh inbox send --repo owner/repo --from "$FROM_AGENT" --title '<short title>' --body - --json
```

Completion criterion: the command prints `sent inbox message #<id>` or returns a JSON message with
`state: "unread"`.

## Check received messages

There is no `lh inbox list` or `lh inbox get` CLI subcommand. Use the LoopHub JSON-RPC Inbox API
through the running web server to discover message ids and fetch message contents, then use
`lh inbox read <id>` to confirm a received message by id.

List unread messages across repos:

```sh
BASE_URL="$(lh info --json | jq -r .baseUrl)"
jq -n '{jsonrpc:"2.0",id:1,method:"inbox/list",params:{state:"unread",limit:50}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

Omit `state`, or pass `"archived"` or `"deleted"`, only when you intentionally need those messages.

Fetch one message body by id:

```sh
jq -n --argjson id 123 \
  '{jsonrpc:"2.0",id:3,method:"inbox/get",params:{id:$id}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

If the list result is empty, report that there are no matching messages and stop; do not fabricate a
message id or mark anything read.

Before fetching or acknowledging a message, inspect the list result's `repo.name` and `to` fields.
Handle only messages for the target repo and acting recipient, or general repo messages where `to` is
`null`.

After reading the body and deciding the message has been handled, acknowledge it with the CLI:

```sh
lh inbox read 123 --session-id "$SESSION_ID" --json
```

## Update message state

Before any state update, verify the message still belongs to the target repo and acting recipient:

```sh
jq -n --argjson id 123 \
  '{jsonrpc:"2.0",id:5,method:"inbox/get",params:{id:$id}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

Then use the CLI:

```sh
lh inbox read 123 --session-id "$SESSION_ID" --json
lh inbox unread 123 --session-id "$SESSION_ID" --json
lh inbox archive 123 --session-id "$SESSION_ID" --json
lh inbox unarchive 123 --session-id "$SESSION_ID" --json
lh inbox delete 123 --session-id "$SESSION_ID" --json
```

`delete` is a soft state change. `unarchive` moves an archived message back to the active Inbox as
`read`, not `unread`.

Use JSON-RPC instead when you are already working through the web API. When the message id is known
and attribution matters, prefer the CLI state commands with `--session-id "$SESSION_ID"`:

```sh
jq -n --argjson id 123 --arg session "$SESSION_ID" \
  '{jsonrpc:"2.0",id:4,method:"inbox/read",params:{id:$id,session_id:$session}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

Completion criterion: the response returns the same `id` with the requested state.

## Failures

- Missing `--from`, `--title`, or `--body`: rerun with the required field.
- Invalid `--from` / `--to`: pass a JSON object, not a string or array.
- `from.repo must match the message repo`: make `--repo` and `from.repo` the same `owner/repo`.
- `inbox message not found`: verify the id with `inbox/list` or `inbox/get` before updating state.
- Web/RPC connection failure: confirm `lh-web` is running and re-resolve `BASE_URL` with `lh info`.
