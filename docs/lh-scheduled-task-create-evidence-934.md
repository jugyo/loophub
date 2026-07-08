# Scheduled task create skill verification (#934)

This records the end-to-end verification for `skills/lh-scheduled-task-create/SKILL.md`.

## Scope

- Skill under test: `/lh-scheduled-task-create`
- Repository: `jugyo/loophub`
- Verification type: create a LoopHub scheduled task from the skill's documented JSON-RPC flow, verify
  it with `scheduledTasks/get`, then delete the temporary task.
- Automatic schedule: manual-only (`times: []`) so the verification task cannot fire later.

## Result

The flow succeeded on July 8, 2026:

- `scheduledTasks/create` returned task `#1` titled `PR 936 scheduled task skill verification`
- `scheduledTasks/get` returned the same title, `agent: "codex"`, `times: []`, and `runs: []`
- `scheduledTasks/delete` returned `{ "ok": true }`

## Command

```sh
BASE_URL="$(lh info --json | jq -r .baseUrl)"
SESSION_ID="pr-936-scheduled-task-skill-verification"

CREATE_RESPONSE="$(
  jq -n \
    --arg repo "jugyo/loophub" \
    --arg title "PR 936 scheduled task skill verification" \
    --arg prompt "Verification task for PR #936. Do not run automatically." \
    --arg agent "codex" \
    --arg session "$SESSION_ID" \
    --argjson times '[]' \
    '{
      jsonrpc: "2.0",
      id: 1,
      method: "scheduledTasks/create",
      params: {
        repo: $repo,
        title: $title,
        prompt: $prompt,
        agent: $agent,
        times: $times,
        session_id: $session
      }
    }' |
    curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
)"

TASK_ID="$(echo "$CREATE_RESPONSE" | jq -r '.result.id')"

jq -n \
  --arg repo "jugyo/loophub" \
  --argjson id "$TASK_ID" \
  '{jsonrpc:"2.0",id:2,method:"scheduledTasks/get",params:{repo:$repo,id:$id}}' |
  curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"

jq -n \
  --arg repo "jugyo/loophub" \
  --argjson id "$TASK_ID" \
  --arg session "$SESSION_ID" \
  '{jsonrpc:"2.0",id:3,method:"scheduledTasks/delete",params:{repo:$repo,id:$id,session_id:$session}}' |
  curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

## Response excerpts

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "id": 1,
    "title": "PR 936 scheduled task skill verification",
    "prompt": "Verification task for PR #936. Do not run automatically.",
    "agent": "codex",
    "times": [],
    "model": null,
    "effort": null
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "id": 1,
    "title": "PR 936 scheduled task skill verification",
    "agent": "codex",
    "times": [],
    "runs": []
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "ok": true
  }
}
```
