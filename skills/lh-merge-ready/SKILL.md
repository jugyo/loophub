---
name: lh-merge-ready
description: >-
  Final pre-merge guard for a LoopHub PR: confirm approve status and no merge conflict, then
  present lh pr merge steps for a human — never merges automatically. Use when the user runs
  /lh-merge-ready {pr id}, or after lh-pr-review approves.
---

# LoopHub merge-ready

Final guard **before a human merges**. Confirm `review_state == APPROVED` and no conflict
(`mergeable_state != dirty`). If clear, **present `lh pr merge` steps only**.

The preceding `lh-pr-review` (same session) already covered acceptance criteria, scope, and
green tests; the PR Evidence section was required at creation (`lh-dev` § PR). Merge-ready does
not re-check them.

**No automatic merge.** Human merges via UI or CLI.

## Invocation

```text
/lh-merge-ready <pr id>
/lh-merge-ready <pr id> --repo owner/name
/lh-merge-ready                      # resolve PR from session context (see below)
```

### PR number resolution (when `<pr id>` omitted)

Same rules as `lh-pr-review` (obvious → infer; not obvious → ask). Typical after
`lh-pr-review` approves in the same session: the PR just reviewed is **obvious**.

Before starting, state the chosen PR in one line:

```text
Merge-ready check for PR #<m>: <title>
```

Dispatch / cron must pass `<pr id>` explicitly (no inference).

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh pr view|merge`, `lh issue comment`
- `--repo owner/name` (omit when cwd is the repo root; **required inside `.worktrees/`**)

## Language

This skill is English. The **merge-decision summary** (`## Report`) is user-facing output: localize its
section headings and text to the user's conversation language. The example in `## Report` is shown in
English; render the same blocks in the conversation language at runtime. Code, CLI, and PR/issue
identifiers stay English.

## Procedure

### 1. PR context

```sh
lh pr view <m> --json --repo <repo>
```

Record: PR number / title / `review_state` / `mergeable_state`.

For the optional completion comment in step 3, note the linked issue number (PR body
`closes #<n>` or the LoopHub DB `--issue` link).

### 2. Pre-merge checklist

The two final guards — confirm both before presenting merge steps:

| Item | Pass when |
|------|-----------|
| `review_state` = APPROVED | LoopHub `GET /pulls/{number}` field is `APPROVED` |
| `mergeable_state` not conflict | LoopHub: `clean` / `dirty` / `unknown`; conflict = **`dirty`** |

If `review_state` is missing from JSON, check the reviews list for the latest `APPROVE`:

```sh
# GET /repos/{owner}/{repo}/pulls/{number}/reviews — trailing APPROVE / REQUEST_CHANGES
```

| Condition | Action |
|-----------|--------|
| Not `APPROVED` | **Stop** — suggest `/lh-pr-review <m>`; do not present merge steps |
| `mergeable_state` = `dirty` | **Stop** — suggest rebase / conflict resolution; do not present merge steps |

### 3. Merge steps (human executes)

**Agent must not run `lh pr merge`.** Human runs after confirmation:

```sh
# Click Merge in UI, or:
lh pr merge <m> --repo <repo> --method squash
```

Squash vs merge commit follows repo convention (LoopHub default: squash).

Optional completion comment:

```sh
lh issue comment <n> --body "merged via PR #<m>" --repo <repo>
```

## Report

The final output is a **merge-decision summary**: everything a human needs to decide
merge / no-merge at a glance, fitting on one screen. Do **not** dump long diffs or
re-explain the whole PR — only the signal needed to decide.

**Sources (no re-review):** pull from `lh pr view <m> --json` (title, `review_state`,
`mergeable_state`, linked `--issue`), the linked issue (`lh issue view <n> --json` — purpose),
and the **same-session** `lh-pr-review` result (findings raised / resolved). Never re-run a
review here.

### When mergeable (APPROVED and not `dirty`)

Print a compact summary with these five blocks:

```text
## Merge-ready: PR #<m> — <title>

**Issue:** #<n> <issue title> — <one-line purpose>
**PR:** <PR web URL>

### Changes
- <key change 1>
- <key change 2>
- <key change 3>

### Review
- ✅ approved (<reviewer / round count>)
- Findings: <raised → resolved summary; "none" if no findings>

### Pre-merge check
- review_state: APPROVED ✅
- mergeable_state: clean ✅ (no conflict)

### Merge steps (human executes)
- Click Merge in the UI, or `lh pr merge <m> --repo <repo> --method squash`
```

Keep each block to a few lines. For localization, see [Language](#language).

### When not mergeable

Do **not** print merge steps. Print the blocker and the next action only:

| Blocker | Next action |
|---------|-------------|
| Not `APPROVED` | `/lh-pr-review <m>` |
| `mergeable_state` = `dirty` | rebase / conflict resolution |

## Called from other skills

After `lh-pr-review` approves, continue in the same session:

```text
/lh-merge-ready <m>
/lh-merge-ready   # OK when the just-approved PR is obvious
```

Also from pr-review sessions when review approves.

## Skill chain (full)

```text
lh-issue-create → (implementation) → lh-pr-review → lh-merge-ready → (human merge)
```

## Prohibited

- **Do not auto-run `lh pr merge`**
- Do not show merge steps without approve or with a conflict (`mergeable_state == dirty`)
- Do not edit code inside merge-ready (send back to issue-dev / pr-review)
