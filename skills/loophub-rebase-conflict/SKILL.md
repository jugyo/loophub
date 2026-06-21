---
name: loophub-rebase-conflict
description: >-
  Resolve merge conflicts on a LoopHub PR head branch in a worktree, run tests, commit, lh sync, and
  hand off to loophub-pr-review. Use when the user runs /loophub-rebase-conflict {pr id}, when
  pull_request.merge_conflict events fire, or when babysit/dispatch routes conflict resolution. Does
  not merge.
---

# LoopHub rebase conflict

Resolve **merge conflicts on a worktree** after main moves → test → commit → `lh sync` → resume
`loophub-pr-review` if needed. **Do not merge.**

## Invocation

```text
/loophub-rebase-conflict <pr id>
/loophub-rebase-conflict <pr id> --repo owner/name
/loophub-rebase-conflict                  # resolve PR from session context (see below)
```

### PR number resolution (when `<pr id>` omitted)

Same rules as `loophub-pr-review` (obvious → infer; not obvious → ask). Typical when
`pull_request.merge_conflict` or babysit routes to a PR already named in the session.

Before starting, state the chosen PR in one line:

```text
Resolving conflicts on PR #<m>: <title>
```

Dispatch / cron must pass `<pr id>` explicitly (no inference).

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- CLI: `lh` or `bun run <repo>/src/cli.ts`
- `--repo owner/name` (omit when cwd is the repo root; **required inside `.worktrees/`**)
- `--actor impl-bot` (when posting comments)

## Worktree rules (same as issue-dev)

From repo root:

```sh
mkdir -p .worktrees
git worktree add .worktrees/issue-<n> -b issue-<n> main
cd .worktrees/issue-<n>
```

If the PR head branch already has a worktree, **reuse it** (no new worktree needed).

| Forbidden | Reason |
|-----------|--------|
| rebase / merge / commit directly on main | Conflicts with human working copy |
| `../.worktrees/` outside repo | Outside Cursor sandbox; permissions every run |
| `../<repo>-issue-<n>` | Pollutes parent directory |

## Procedure

### 1. Context

```sh
lh pr view <m> --repo <repo>
```

Record: PR number / title / `head.ref` / `base.ref` / repo absolute path.

If PR body has `closes #<n>`, confirm issue goal:

```sh
lh issue view <n> --repo <repo>
```

Make work visible:

```sh
lh pr comment <m> --body "Starting conflict resolution" --actor impl-bot --repo <repo>
```

### 2. Checkout head

Follow [Head worktree bootstrap](../README.md#head-worktree-bootstrap) — move to `.worktrees/<head.ref>` (reuse if present, else `git worktree add`):

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
```

### 3. Incorporate base

**Default: rebase** (same as issue-dev conflict section):

```sh
git fetch origin main 2>/dev/null || true
git rebase main
```

Use `git merge main` only when rebase is inappropriate (follow history policy).

### 4. Resolve conflicts

- Open conflicted files; respect **both** PR intent and base changes
- If intents contradict, abort rebase and escalate to a human
- After resolution:

```sh
git add <paths>
git rebase --continue   # or git commit for merge
```

### 5. Test

Repo standard (e.g. `bun test`). **Green before proceeding**, same as before PR.

### 6. Sync

LoopHub reads the same `.git` directly (no push):

```sh
lh sync
```

### 7. Report and resume review

```sh
lh pr comment <m> --body "Conflict resolution complete. Please re-review." --actor impl-bot --repo <repo>
```

**Continue in same session (default):**

```text
/loophub-pr-review <m>
```

Re-review with the quality + security reviewers until `approve` (follow `loophub-pr-review` SKILL;
reviewer mechanism is host-mapped there).

Skip pr-review only if user said "stop at rebase".

## Shared with issue-dev

| Item | issue-dev | rebase-conflict |
|------|-----------|-----------------|
| worktree location | `.worktrees/issue-<n>` | same, or existing head worktree |
| rebase command | `git rebase main` | same |
| sync | `lh sync` | same |
| merge | do not | do not |
| review | pr-review after PR create | pr-review after resolution |

If conflict occurs during an issue-dev session, apply steps 2–7 from this skill.

## Prohibited

- Do not merge
- Do not work on main
- Do not expect server-side automatic conflict resolution (`pull_request.merge_conflict` requires
  human/agent resolution)
