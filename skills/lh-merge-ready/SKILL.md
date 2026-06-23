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

- Checklist results (approve status / conflict status)
- If mergeable, **steps only** (human executes)
- If not, next action (pr-review / conflict resolution)

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
