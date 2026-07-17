---
name: lh-merge-ready
description: >-
  Final pre-merge guard for a LoopHub PR: confirm pass status and no merge conflict, present
  lh pr merge steps for a human, and print the change's valid evidence screenshot paths at the end
  — never merges automatically. Use when the user runs /lh-merge-ready {pr id}, or after
  lh-pr-review passes.
---

# LoopHub merge-ready

Final guard **before a human merges**. Confirm `review_state == PASSED` and no conflict
(`mergeable_state != conflict`). If clear, **present `lh pr merge` steps only**.

The preceding `lh-pr-review` (same session) already covered acceptance criteria, scope, and
green tests; the PR Evidence section was seeded when the Workflow run opened the PR and filled in by
its Execute step. Merge-ready does not re-check them.

As the **last block of its report**, merge-ready also surfaces the change's **evidence
screenshots**: it reads the persistent evidence directory (the Workflow run's Execute step and
`lh-pr-review` write here during implementation and fixes), validates each image, and prints the
**paths** of the valid
ones — or states there is none — so a human can eyeball the change before merging.

**No automatic merge.** Human merges via UI or CLI.

## Invocation

```text
/lh-merge-ready <pr id>
/lh-merge-ready <pr id> --repo owner/name
/lh-merge-ready                      # resolve PR from session context (see below)
```

### PR number resolution (when `<pr id>` omitted)

Same rules as `lh-pr-review` (obvious → infer; not obvious → ask). Typical after
`lh-pr-review` passes in the same session: the PR just reviewed is **obvious**.

Before starting, state the chosen PR in one line:

```text
Merge-ready check for PR #<m>: <title>
```

Dispatch / cron must pass `<pr id>` explicitly (no inference).

## LoopHub

- **Server**: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh` (on PATH)
- **`--repo owner/name`**: omit when cwd is the registered repo root or a LoopHub worktree for that
  repo; required outside those paths
- **Commands used here**: `lh pr view|merge`, `lh issue comment`

### Web URL (for reporting)

```text
{baseUrl}/r/{owner}/{repo}/pulls/{m}
```

- **baseUrl**: `lh info --json | jq -r .baseUrl` (do **not** read `~/.loophub/config.json` directly —
  `lh info` applies the canonical resolution order: `LOOPHUB_URL` → config `url` →
  `http://localhost:${LOOPHUB_PORT:-8730}`)
- **owner/repo**: `--repo`, or repo resolution from cwd

## Language

The **merge-decision summary** (`## Report`) is user-facing output: localize its
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
| `review_state` = PASSED | LoopHub `GET /pulls/{number}` field is `PASSED` |
| `mergeable_state` not conflict | LoopHub: `clean` / `conflict` / `unknown`; the conflict value is **`conflict`** |

If `review_state` is missing from JSON, check the reviews list for the latest `PASS`:

```sh
# GET /repos/{owner}/{repo}/pulls/{number}/reviews — trailing PASS / REQUEST_CHANGES
```

| Condition | Action |
|-----------|--------|
| Not `PASSED` | **Stop** — suggest `/lh-pr-review <m>`; do not present merge steps |
| `mergeable_state` = `conflict` | **Stop** — suggest rebase / conflict resolution; do not present merge steps |

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

### When mergeable (PASSED and not `conflict`)

Print a compact summary with these six blocks:

```text
## Merge-ready: PR #<m> — <title>

**Issue:** #<n> <issue title> — <one-line purpose>
**PR:** <PR web URL>

### Changes
- <key change 1>
- <key change 2>
- <key change 3>

### Review
- ✅ passed (<reviewer / round count>)
- Findings: <raised → resolved summary; "none" if no findings>

### Pre-merge check
- review_state: PASSED ✅
- mergeable_state: clean ✅ (no conflict)

### Merge steps (human executes)
- Click Merge in the UI, or `lh pr merge <m> --repo <repo> --method squash`

### Evidence screenshots
- <abs path 1> — <one line: what it shows>
- <abs path 2> — <one line: what it shows>
```

Keep each block to a few lines. For localization, see [Language](#language). Build the trailing
`### Evidence screenshots` block per [Evidence screenshots](#evidence-screenshots-last-block).

### When not mergeable

Do **not** print merge steps. Print the blocker and the next action — then still append the
trailing [Evidence screenshots](#evidence-screenshots-last-block) block:

| Blocker | Next action |
|---------|-------------|
| Not `PASSED` | `/lh-pr-review <m>` |
| `mergeable_state` = `conflict` | rebase / conflict resolution |

### Evidence screenshots (last block)

Append this as the **last block merge-ready itself emits** — in **both** the mergeable and the
not-mergeable case — so the change's visual evidence is grouped at the end.

1. **List** the persistent evidence directory for this PR:

   ```sh
   DIR="${LOOPHUB_HOME:-$HOME/.loophub}/evidence/<owner>/<repo>/issue-<n>"  # or .../pr-<m> if no linked issue
   ls "$DIR" 2>/dev/null
   ```

   `<n>` is the linked issue (PR body `closes #<n>` / the `--issue` link from step 1) — the
   directory is keyed by the **linked issue number**, not the `pr-<m>` worktree name, so the Workflow
   run's Execute step, `lh-pr-review`, and this skill all resolve the same directory. For a PR with no
   linked issue, use `pr-<m>` instead.

2. **Validate each file — keep only valid evidence.** Open each image and keep it only when it
   **actually shows this PR's change** and is readable. Exclude:
   - unrelated / old / a different screen than this change
   - blank / all-black / corrupt / failed-to-load (no usable signal)

3. **Print the kept paths** (path strings — not embedded images), grouped under the heading:

   ```text
   ### Evidence screenshots
   - <abs path> — <one line: what it shows>
   ```

4. If **no valid screenshot remains** (directory absent / empty, or every image excluded), do not
   invent one — print the heading with an explicit "none" line instead of a path:

   ```text
   ### Evidence screenshots
   - No valid evidence screenshot for this change.
   ```

Localize the heading and the "none" line to the conversation language (see [Language](#language));
keep paths verbatim.

## Called from other skills

After `lh-pr-review` passes, continue in the same session:

```text
/lh-merge-ready <m>
/lh-merge-ready   # OK when the just-passed PR is obvious
```

Also from pr-review sessions when review passes.

## Skill chain (full)

```text
lh-issue-create → Start workflow (Workflow run) → lh-pr-review → lh-merge-ready → (human merge)
```

## Prohibited

- **Do not auto-run `lh pr merge`**
- Do not show merge steps without pass or with a conflict (`mergeable_state == conflict`)
- Do not edit code inside merge-ready (send back to the Workflow run's Execute step / pr-review)
