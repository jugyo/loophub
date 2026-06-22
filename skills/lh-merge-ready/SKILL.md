---
name: lh-merge-ready
description: >-
  Final pre-merge check for a LoopHub PR: diff vs acceptance criteria, tests, and approve status.
  Presents lh pr merge steps for a human — never merges automatically. Use when the user runs
  /lh-merge-ready {pr id}, or after lh-pr-review approves.
---

# LoopHub merge-ready

Final check **before a human merges**. Cross-check diff vs Acceptance criteria, re-run tests, confirm
`approve` status. If all clear, **present `lh pr merge` steps only**.

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
- **CLI**: `lh pr view|diff|merge`, `lh issue view`
- `--repo owner/name` (omit when cwd is the repo root; **required inside `.worktrees/`**)

## Procedure

### 1. PR context

```sh
lh pr view <m> --repo <repo>
lh pr diff <m> --repo <repo>
```

Record: PR number / title / `head.ref` / `base.ref` / `mergeable_state` / `review_state` / repo
absolute path.

Identify issue number from PR body `closes #<n>` or the LoopHub DB `--issue` link. AC cross-check works
with `--issue` alone even when body is empty (linked issue is stored in DB). If neither is present,
infer from body; ask the user if unclear.

### 2. Approve check (required)

`lh-pr-review` must have **`approve`d**.

```sh
lh pr view <m> --json --repo <repo>
# review_state must be APPROVED (LoopHub GET /pulls/{number} field)
```

| `review_state` | Action |
|----------------|--------|
| `APPROVED` | Continue |
| `CHANGES_REQUESTED` | **Stop** — suggest `/lh-pr-review <m>` |
| `READY_FOR_RE_REVIEW` | **Stop** — waiting for re-review |
| `null` / `COMMENTED` | **Stop** — review incomplete; suggest `/lh-pr-review <m>` |

If `review_state` missing from JSON, check reviews list for latest `APPROVE`:

```sh
# GET /repos/{owner}/{repo}/pulls/{number}/reviews — trailing APPROVE / REQUEST_CHANGES
```

Do not present merge steps without approve.

### 3. Acceptance criteria cross-check

```sh
lh issue view <n> --repo <repo>
```

Extract **Acceptance criteria** from issue body and Agent brief comment (if any). Check each item against
`lh pr diff`:

- [ ] Each AC satisfied by diff / tests
- [ ] No out-of-scope changes (confirm reason if any)
- [ ] Blocked by resolved (stop if open references remain)

If any AC unmet, report **not mergeable** and suggest sending back to issue-dev.

### 3.5 PR evidence check

Read the PR body (`lh pr view <m>`). It must include an **Evidence** section (heading may be
localized — same language as Summary / Test plan) with substantive content — not placeholders.

| Check | Pass when |
|-------|-----------|
| Evidence section present | Heading exists after the test-plan section (localized OK) and before `Closes #` |
| Not empty | At least one bullet with real output, screenshot reference, or explicit **N/A** rationale |
| Matches change type | UI PRs include visual proof; code PRs include test output excerpt |

Fail → **not mergeable**. Ask impl-bot / issue-dev to update the PR body (no code changes required).

### 4. Re-run tests

**Do not `git checkout head.ref` on the main checkout.** Follow [Head worktree bootstrap](../README.md#head-worktree-bootstrap) — `cd` into `.worktrees/<head.ref>` (or `git worktree add` if missing), then run tests:

```sh
ROOT="<local_path>"
WT="$ROOT/.worktrees/<head.ref>"
if [ "$(pwd -P)" = "$(cd "$WT" 2>/dev/null && pwd -P)" ]; then
  : # already in target worktree
elif [ -d "$WT" ]; then
  cd "$WT"
else
  git -C "$ROOT" worktree add ".worktrees/<head.ref>" <head.ref> && cd "$WT"
fi
bun test   # example — follow project convention
```

On failure, **not mergeable**. Report failure and suggest fixes.

### 5. Pre-merge checklist

Present to human only when all OK:

| Item | Status |
|------|--------|
| `review_state` = APPROVED | ✓ |
| Acceptance criteria met | ✓ |
| PR Evidence section substantive | ✓ |
| Tests green | ✓ |
| `mergeable_state` not conflict | verify (LoopHub: `clean` / `dirty` / `unknown`; conflict = **`dirty`**) |

If `mergeable_state` is `dirty`, do not show merge steps; suggest rebase / conflict resolution.

### 6. Merge steps (human executes)

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

- Checklist results (pass / fail per item)
- Test command and results
- AC cross-check summary (list unmet if any)
- Approve status
- If mergeable, **steps only** (human executes)
- If not, next action (pr-review / issue-dev / conflict resolution)

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
- Do not show merge steps without approve, failing tests, unmet AC, or conflict
- Do not edit code inside merge-ready (send back to issue-dev / pr-review)
