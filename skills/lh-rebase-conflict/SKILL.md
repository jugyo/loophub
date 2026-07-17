---
name: lh-rebase-conflict
description: >-
  Resolve merge conflicts on a LoopHub PR head branch in a worktree, run tests, commit, and
  hand off to lh-pr-review. Use when the user runs /lh-rebase-conflict {pr id}, when
  pull_request.merge_conflict events fire, or when babysit/dispatch routes conflict resolution. Does
  not merge.
---

# LoopHub rebase conflict

Resolve **merge conflicts on a worktree** after main moves → test → commit → resume
`lh-pr-review` if needed. **Do not merge.**

## Invocation

```text
/lh-rebase-conflict <pr id>
/lh-rebase-conflict <pr id> --repo owner/name
/lh-rebase-conflict                  # resolve PR from session context (see below)
```

### PR number resolution (when `<pr id>` omitted)

Same rules as `lh-pr-review` (obvious → infer; not obvious → ask). Typical when
`pull_request.merge_conflict` or babysit routes to a PR already named in the session.

Before starting, state the chosen PR in one line:

```text
Resolving conflicts on PR #<m>: <title>
```

Dispatch / cron must pass `<pr id>` explicitly (no inference).

## LoopHub

- **Server**: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh` (on PATH)
- **`--repo owner/name`**: omit only when cwd is the repo root; required inside a worktree
- **Auto-sync**: `lh-web` sweeps open PRs' head SHAs and auto-fires `pull_request.updated` — after
  committing, rebasing, or merging on a PR head, no manual sync call is needed
- `--actor impl-bot` (when posting comments)

## Worktree rules

Work on the PR's existing head branch (`head.ref` — `loophub/pr-<m>` for Workflow-run PRs), never on
the main checkout. If the head branch already has a worktree — e.g. the Workflow-run one at
`~/.loophub/worktrees/<owner>/<repo>/pr-<m>` — **reuse it** (no new worktree needed). Otherwise,
add one under `.worktrees/<head.ref>` from repo root (see step 2 for the exact bootstrap procedure).

| Forbidden | Reason |
|-----------|--------|
| rebase / merge / commit directly on main | Conflicts with human working copy |
| `../.worktrees/` outside repo | Outside Cursor sandbox; permissions every run |
| `../<repo>-pr-<m>` | Pollutes parent directory |

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

Move to `.worktrees/<head.ref>` (reuse if already checked out somewhere, else `git worktree add`):

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

**Default: rebase** (same rebase-first policy the Workflow run's Execute step follows):

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

Repo standard (e.g. `npm test` or `bun test`). **Green before proceeding**, same as before PR.

### 6. Report and resume review

LoopHub reads the same `.git` directly (no push); auto-sync (see [§ LoopHub](#loophub)) picks up
the new head — no manual sync needed.

```sh
lh pr comment <m> --body "Conflict resolution complete. Please re-review." --actor impl-bot --repo <repo>
```

**Continue in same session (default):**

```text
/lh-pr-review <m>
```

Re-review with the quality + security reviewers until `pass` (follow `lh-pr-review` SKILL;
reviewer mechanism is host-mapped there).

Skip pr-review only if user said "stop at rebase".

## Shared with the Execute step

| Item | Execute step | rebase-conflict |
|------|--------------|-----------------|
| worktree location | `~/.loophub/worktrees/<owner>/<repo>/pr-<m>` (provisioned by the Workflow run) | that one reused, or `.worktrees/<head.ref>` |
| rebase command | `git rebase main` | same |
| merge | do not | do not |
| review | pr-review after PR create | pr-review after resolution |

If conflict occurs during a Workflow run's Execute session, apply steps 2–6 from this skill.

## Prohibited

- Do not merge
- Do not work on main
- Do not expect server-side automatic conflict resolution (`pull_request.merge_conflict` requires
  human/agent resolution)
