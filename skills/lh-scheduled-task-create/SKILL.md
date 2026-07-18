---
name: lh-scheduled-task-create
description: >-
  Create a LoopHub scheduled task from conversation, then STOP. Use when the user runs
  /lh-scheduled-task-create, asks to add/create/register a scheduled task, scheduled run,
  recurring task, 定期タスク, or scheduled task 追加. Extract the task definition from the
  conversation, ask only for missing required fields, create it through LoopHub, verify it,
  and report the result. Do not implement issues, open PRs, or merge.
---

# LoopHub scheduled task create

Create a LoopHub scheduled task from conversation. **Stop after the task is created, verified, and
reported. Do not implement issues, open PRs, merge, or chain to other skills.**

## Scope boundary (read first)

**This skill ends when the scheduled task exists and has been verified.** A request to add a scheduled
task is an operations/configuration request, not an implementation request.

| Do | Do not |
|----|--------|
| Extract the task definition, ask only for missing required fields, call `scheduledTasks/create`, verify, report | Implement the scheduled task's prompt yourself; create branches, issues, or PRs; merge |
| Use the existing LoopHub JSON-RPC scheduled-task API | Redesign the scheduled-task engine or add new API surfaces |
| Suggest follow-on commands in text when useful | Run the new task immediately unless the user explicitly asked for a run-now check |

### Done when

- [ ] Required fields are known: repository, title, prompt, agent, and times
- [ ] `scheduledTasks/create` succeeded
- [ ] Creation is verified with `scheduledTasks/get` or `scheduledTasks/list`
- [ ] Task id, title, schedule, agent, and UI URL are reported to the user
- [ ] The user has not separately asked to run it immediately

### Common mistakes

```text
Do not create an issue or PR for the task instead of registering the scheduled task.
Do not ask for every field when the conversation already contains enough information.
Do not invent a schedule when the user did not provide one.
Do not run the task immediately by default after creating it.
Do not continue to a Workflow run (Start workflow) or any review/merge step.
Create the scheduled task -> verify -> report -> stop.
```

## Invocation

`/lh-scheduled-task-create` - create a scheduled task from conversation context.

### Question mode (no arguments, no context)

If invoked without arguments and without enough conversation context to derive the task, ask exactly
one open question and stop there:

> What should the scheduled task do?

After the user replies, infer what you can and ask only for the still-missing required fields, one
small follow-up at a time.

## Required information

Extract these fields from the conversation:

- **Repository**: `owner/name`; infer from cwd only when it clearly resolves to the target repo. Inside
  a LoopHub worktree or any ambiguous directory, do not rely on cwd inference: use an explicit
  `owner/name` from the conversation or ask before previewing.
- **Title**: short, human-readable task name
- **Prompt**: the exact saved prompt the agent should run when the task fires
- **Agent**: `codex` or `claude-code`; if the user explicitly asks to use the default, resolve it with
  `settings/get` before creating; otherwise ask when missing
- **Times**: zero or more local 24-hour `HH:MM` times; ask when the user wants automatic runs but did
  not provide a time
- **Model**: optional override; omit or send `null` to use the per-agent application default
- **Effort**: optional override; omit or send `null` to use the per-agent application default

Normalize times before creating:

- Use the LoopHub host's local time.
- Convert natural-language times to 24-hour `HH:MM`.
- Deduplicate and sort multiple times.
- If the user asks for a manual-only task with no automatic schedule, use `times: []`.
- If the requested cadence is not representable by LoopHub's current model of once-per-day local
  times, explain the limitation and ask for one or more daily times.

## LoopHub

- **Server**: default `http://localhost:8730` (`lh info --json` is the source of truth)
- **API**: JSON-RPC 2.0 over `POST /rpc`
- **Methods used here**: `settings/get`, `scheduledTasks/create`, `scheduledTasks/get`,
  `scheduledTasks/list`; optional run-now verification also uses `scheduledTasks/run`
- **`repo`**: pass `owner/name`

### Web URL (for reporting)

Always show the user a UI URL when reporting creation:

```text
{baseUrl}/r/{owner}/{repo}/scheduled-tasks
```

Resolve `baseUrl` with:

```sh
lh info --json | jq -r .baseUrl
```

If the LoopHub web server is not running, start it before using JSON-RPC:

1. If `lh-web` is on PATH, run `lh-web`.
2. In this repository's source checkout, run:

```sh
npm run lh-web
```

3. If neither command applies, ask the user how this LoopHub instance is launched.

## Language

Interactive reports should match the user's conversation language. The scheduled task's **title** and
**prompt** should preserve the user's intended language; translate only when the user asks. Code, CLI,
JSON field names, and identifiers stay English.

## Procedure

### 1. Gather context

Extract the required information from the conversation. Ask only for fields that are genuinely
missing or ambiguous.

Useful follow-up questions:

- Missing repository: "Which LoopHub repo should this scheduled task belong to?"
- Missing task behavior: "What exact prompt should the agent run?"
- Missing agent: "Should this run with `codex` or `claude-code`?"
- Missing schedule: "What local time or times should it run? Use 24-hour time if possible."

Do not ask about optional model or effort unless the user mentioned model choice, performance, cost,
or reasoning depth.

If the user explicitly asks to use the default agent, resolve it before previewing or creating:

```sh
BASE_URL="$(lh info --json | jq -r .baseUrl)"

jq -n '{jsonrpc:"2.0",id:0,method:"settings/get",params:{}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

Use `result.codingAgent` as the concrete `agent` value for `scheduledTasks/create`. If it is missing,
ask the user to choose `codex` or `claude-code`.

### 2. Preview before creating

Before writing, show the operator a concise preview:

```text
Scheduled task preview
- Repo: <owner/name>
- Title: <title>
- Agent: <codex|claude-code>
- Times: <HH:MM, ... | manual-only>
- Model: <override | default>
- Effort: <override | default>
- Prompt:
  <prompt>
```

If any required value is uncertain, ask before proceeding.

### 3. Create

Use JSON-RPC through the running `lh-web` server. Prefer `jq` to assemble JSON so prompt quoting is
safe.

```sh
BASE_URL="$(lh info --json | jq -r .baseUrl)"
SESSION_ID="lh-scheduled-task-create-$(date +%s)"

jq -n \
  --arg repo "<owner/name>" \
  --arg title "<title>" \
  --arg prompt "<prompt>" \
  --arg agent "<codex|claude-code>" \
  --arg session "$SESSION_ID" \
  --argjson times '["09:00"]' \
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
```

For optional overrides, include `"model": "<model>"` and/or `"effort": "<effort>"`. To explicitly
clear an override, pass `null`.

If the response contains an `error`, do not report success. Explain the error and ask for any missing
or corrected input.

### 4. Verify

Verify the created task by id:

```sh
TASK_ID="<task-id>"

jq -n \
  --arg repo "<owner/name>" \
  --argjson id "$TASK_ID" \
  '{jsonrpc:"2.0",id:2,method:"scheduledTasks/get",params:{repo:$repo,id:$id}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

Check that the returned title, prompt, agent, and times match the preview. If verification fails, do
not hide the failure; report what was created and what did not match.

### 5. Optional run-now check

Skip this by default. Run the task immediately only if the user explicitly asked to verify by running
it now:

```sh
TASK_ID="<task-id>"

jq -n \
  --arg repo "<owner/name>" \
  --argjson id "$TASK_ID" \
  --arg session "$SESSION_ID" \
  '{jsonrpc:"2.0",id:3,method:"scheduledTasks/run",params:{repo:$repo,id:$id,session_id:$session}}' |
curl -sS -H 'content-type: application/json' --data-binary @- "$BASE_URL/rpc"
```

Report the run status and Herdr tab/pane refs from the response. Do not wait for the agent to finish
its whole task unless the user asked for that too.

### 6. Report and stop

Report in this shape:

```markdown
Created scheduled task #<id>: <title>

- Repo: `<owner/name>`
- Agent: `<codex|claude-code>`
- Times: `<HH:MM, ...>` or `manual-only`
- Model/effort: `<default|override>`
- Verified: `scheduledTasks/get` returned the expected task
- URL: <{baseUrl}/r/{owner}/{repo}/scheduled-tasks>
```

Then stop. Do not create issues, open PRs, or continue to another skill.
