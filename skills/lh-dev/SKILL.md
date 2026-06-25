---
name: lh-dev
description: >-
  Implement or fix from a LoopHub issue, then run the PR review-fix loop in the same session.
  Starts ONLY when the user explicitly runs /lh-dev, asks to implement/fix, or LoopHub
  dispatch/cron starts issue-dev — NOT after issue-create alone. Do not merge.
---

# LoopHub issue dev

Implement or fix per the issue, open a PR, then **by default** continue in the same session:
**PR → `lh-pr-review` → `lh-merge-ready`** (human merge). **Do not merge.**

## Startup guard (read first)

**Start only when implementation is explicitly requested.** Do **not** auto-start right after an issue
creation skill (`lh-issue-create`, `lh-plan-to-issues`, `to-issues`).

### OK to start (any one)

| Condition | Example |
|-----------|---------|
| User runs `/lh-dev <n>` | `/lh-dev 42` |
| User explicitly asks to **implement / fix / start** | "implement this", "fix it", "continue implementation", "fix #42" |
| LoopHub dispatch / cron starts issue-dev | `issue.labeled`, etc. |

### Do not start

- User asked to **create an issue only** (file an issue, create tickets)
- Issue creation skill just published an issue and the user did not ask to implement
- Issue has `ready-to-build` only (label ≠ implementation request)
- Read code to refine AC and "fix while you're here"

### When unsure

**Stop and confirm:** "Should I implement #n? If you only wanted filing, I'll stop here."

Do not assign, create a worktree, or edit source until the user chooses implementation.

## Invocation

`/lh-dev <issue id>` — take the number from the argument. If omitted, ask the user which issue
to work on.

**If the startup guard is not satisfied, stop here** — even if you know the issue number.

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## Called from other skills

| Caller | Continue? |
|--------|-----------|
| `lh-issue-create` / `lh-plan-to-issues` / `to-issues` | ❌ No auto-continue; separate explicit user request only |
| LoopHub dispatch / cron | ✅ Start issue-dev |

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- CLI: `lh` (on PATH)
- `--repo owner/name` (omit only when cwd is the repo root; **required inside a worktree**)
- `--session-id` — attribution for comments and other writes (`lh dev` assigns the issue for you)

### Web URL (for reporting)

Always show the user a UI URL when reporting (no CLI output changes required).

| Kind | Format |
|------|--------|
| issue | `{baseUrl}/r/{owner}/{repo}/issues/{n}` |
| PR | `{baseUrl}/r/{owner}/{repo}/pulls/{m}` |

- **baseUrl**: `lh info --json | jq -r .baseUrl` (do **not** read `~/.loophub/config.json` directly —
  `lh info` applies the canonical resolution order: `LOOPHUB_URL` → config `url` → `http://localhost:${LOOPHUB_PORT:-8730}`)
- **owner/repo**: `--repo` or repo resolution from cwd (same as `lh issue view`)

Example: `http://localhost:8730/r/jugyo/local-github/issues/73`

## Language

This skill is English. **PR output** (title, body headings, user-facing summaries) must match the
user's **conversation language** — translate section headings and text. Code, CLI, and commit messages
stay English.

## Procedure

### 1. Before starting implementation (mandatory)

```sh
lh issue view <n> --repo <repo>
```

**Before editing source**, show the user a short overview:

- **#n** — title
- **Goal**: done criteria (1–3 sentences)
- **Acceptance criteria**: pull in the issue's AC (the checklist mirrored into the PR body at step 5)
- **Out of scope**: if any
- **Issue URL** — Web URL format above as a markdown link for the user

Do not proceed to step 2 until this summary is written (in the chat response for interactive sessions,
or in the session log for AFK/cron).

### 2. Worktree & session (already provisioned by `lh dev`)

When launched via `lh dev <n>`, the session **starts already inside the issue worktree** with the setup
below done for you — do **not** redo it:

- **Worktree**: provisioned at `~/.loophub/worktrees/<owner>/<repo>/issue-<n>` on branch
  `loophub/issue-<n>` (off `main`); the session's cwd is already there.
- **Session**: registered (agent `lh-dev`) and the issue **already assigned** to it. On an assign 409
  (re-launch, or another session already assignee), `lh dev` warns and continues — you do not assign
  again.

So skip straight to implementing (§3). Verify the setup once:

```sh
git status                          # tree clean; on branch loophub/issue-<n>
git rev-parse --abbrev-ref HEAD     # loophub/issue-<n>
```

Inside the worktree, **`--repo owner/name` is required** for every `lh` call — the worktree lives
outside the main checkout, so `resolveRepo()` cannot infer the repo from cwd.

Progress is already visible via the assignment and (later) the PR; post `lh issue comment <n> --repo
<repo>` only if you need to flag a blocker or hand-off for a human watching the UI.

#### Another session already owns the issue

`lh dev` assigns automatically and only warns on 409, so a duplicate assign is not your concern. But if
you find a **different active session** is genuinely working the same issue (not just a stale re-launch
of your own), **stop** and ask the human whether to wait, pick another issue, or take over. Do not
overwrite assignment or edit in parallel.

#### Manual launch (not via `lh dev`)

Only if you arrived here **without** `lh dev` (ad-hoc, or a host that doesn't use the launcher): set up
the worktree and assignment yourself first, then continue.

```sh
git worktree add ~/.loophub/worktrees/<owner>/<repo>/issue-<n> -b loophub/issue-<n> main
cd ~/.loophub/worktrees/<owner>/<repo>/issue-<n>
SID="$(uuidgen)"
lh session register --id "$SID" --agent impl-bot --session "$SID"
lh issue assign <n> --session-id "$SID" --repo <repo>   # stop on 409: see "Another session" above
```

#### Parallel LoopHub server (only when changing server code)

The CLI uses production `:8730` by default. **Never stop `:8730`.** If your change touches the server
itself and you need to exercise the new code, run a second server on a free port and point the CLI at it:

```sh
lh-web --port 8731 --poll-ms 0 &
LOOPHUB_URL=http://localhost:8731 lh issue view <n> --repo <repo>
```

| Variable | Purpose |
|----------|---------|
| `LOOPHUB_PORT` | Server listen port (default 8730) |
| `LOOPHUB_URL` | CLI API target (set explicitly when running in parallel) |

`LOOPHUB_HOME` (default `~/.loophub`) is shared across ports, so the production UI (8730) still shows the
data; new API behavior exists only on the new server code. The existing `url` in `config.json` is read
first, so set `LOOPHUB_URL` explicitly when running in parallel.

### 3. Implement

Match existing naming, types, tests, and style. Stay within issue scope. Commit messages: concise
outcome only (no narrative).

### 4. Test

Use the repo standard command (e.g. `npm test`). **Green before PR.**

While testing, **capture evidence for the PR body** (step 5):

- Save the command and a short excerpt of green output (pass/fail counts, key lines)
- For UI or visual changes, take screenshots before opening the PR (browser tool, manual capture, or
  generated assets under the repo)
- For CLI/API fixes, paste a representative command and response snippet

Do not open a PR with checkboxes only — reviewers need proof you ran the verification.

### 5. PR

No push required (LoopHub reads the same `.git` directly). Default uses the production server (`:8730`).

**`--body` is required.** Do not create a PR with only `--title` and `--issue` (empty description is
forbidden).

#### Body template (required sections)

Match heading language to the conversation (localized Summary / Acceptance criteria / Test plan /
Evidence headings; see `skills/_shared/human-language.md` when present). Pass the body via HEREDOC:

```sh
lh pr create --repo <repo> --head loophub/issue-<n> --base main \
  --title "..." --issue <n> --actor impl-bot \
  --body "$(cat <<'EOF'
## Summary
- <1–3 bullets: what changed and why>

## Acceptance criteria
- [x] <AC item satisfied by this PR — mirror from the issue>
- [ ] <AC item not yet met / out of scope> — <one-line reason>

## Test plan
- [x] <how you verified — e.g. npm test>

## Evidence
- **Tests**: `<command>` — excerpt, e.g. `42 pass, 0 fail` or the final summary line
- **UI / visual** (when applicable): screenshot path or markdown image; one line on what it shows
- **CLI / API** (when applicable): command + representative output snippet
- **N/A** (docs-only / trivial): one line why substantive evidence does not apply — do not omit this section

Closes #<n>
EOF
)"
```

When running a **parallel server** in the worktree (§2 `lh-web --port 8731`), set `LOOPHUB_URL`:

```sh
LOOPHUB_URL=http://localhost:8731 lh pr create --repo <repo> --head loophub/issue-<n> --base main \
  --title "..." --issue <n> --actor impl-bot \
  --body "$(cat <<'EOF'
## Summary
- <1–3 bullets: what changed and why>

## Acceptance criteria
- [x] <AC item satisfied by this PR — mirror from the issue>
- [ ] <AC item not yet met / out of scope> — <one-line reason>

## Test plan
- [x] <how you verified — e.g. npm test>

## Evidence
- **Tests**: `<command>` — excerpt, e.g. `42 pass, 0 fail` or the final summary line
- **UI / visual** (when applicable): screenshot path or markdown image; one line on what it shows
- **CLI / API** (when applicable): command + representative output snippet
- **N/A** (docs-only / trivial): one line why substantive evidence does not apply — do not omit this section

Closes #<n>
EOF
)"
```

| Required | Content |
|----------|---------|
| Summary | What changed and why (1–3 bullets) |
| Acceptance criteria | Mirror the issue's AC as a checklist; check **only** items this PR actually satisfies (unmet / out-of-scope stay unchecked with a one-line reason) |
| Test plan | Verification performed (checked items you actually ran) |
| Evidence | Concrete proof from step 4 — test output excerpt, screenshots, CLI snippets, or explicit N/A |
| `Closes #<n>` | Issue number (use with `--issue`; merge-ready can also parse body) |

The **Acceptance criteria** section mirrors the issue's AC verbatim as a checklist. Tick an item only
when the PR genuinely meets it; leave anything unmet or out of scope unchecked and append a one-line
reason. This is the human- and reviewer-facing record that the PR satisfies the issue — `lh-pr-review`
runs an Acceptance reviewer against the same AC.

`--issue` stores the link in the DB; UI/API show it both ways. `Closes #<n>` helps merge-ready find
the issue from body. No manual issue comment needed.

After create, confirm the body is non-empty:

```sh
lh pr view <m> --repo <repo>   # body must include Summary, Acceptance criteria, Test plan, and Evidence
```

#### Evidence rules

| Change type | Minimum evidence |
|-------------|------------------|
| Code / tests | Test command + green output excerpt (not "ran tests") |
| UI / UX | Screenshot or markdown image reference + caption |
| CLI / API | Command + representative output |
| Docs / skills only | Evidence section with **N/A** and one-line rationale |

Empty Evidence or placeholder bullets (`TBD`, `TODO`, unchecked test plan only) → fix the body before
step 6.

### 6. Report

Goal summary / changed files / test results / PR number / **PR URL** (Web URL format as markdown link) /
**PR description written** (confirm non-empty body with Evidence via `lh pr view`)

**Do not end the session here.** Step 6 is a checkpoint only — **step 7 (Review loop) is mandatory**
unless the user said "stop at PR". Proceed immediately to `/lh-pr-review <m>` without waiting
for another user message.

### 7. Review loop (default, same session)

After creating the PR, **without ending this session**, continue with `lh-pr-review`:

```text
/lh-pr-review <m>
```

Bugbot + Security review → fix on head in this session if needed → re-review until `approve`. See
`skills/lh-pr-review/SKILL.md`.

Skip only if the user said "stop at PR".

### 8. merge-ready (after approve, same session)

When `lh-pr-review` returns `approve`, **without ending this session**, pre-merge check:

```text
/lh-merge-ready <m>
```

See `skills/lh-merge-ready/SKILL.md`. Human performs merge.

### 9. Final output (always)

**Whenever this skill ends — at any exit point** (PR created and "stop at PR", review loop done,
merge-ready done, or stopping early) — the **last line of the response must be the PR URL** as a
markdown link, on its own, so the human can click it immediately:

```text
**PR:** [<owner>/<repo> #<m> — <title>](<baseUrl>/r/<owner>/<repo>/pulls/<m>)
```

- Use the Web URL format from §"Web URL (for reporting)" (`{baseUrl}/r/{owner}/{repo}/pulls/{m}`).
- Print it even if the PR URL already appeared earlier (e.g. step 6) — it must be the final line.
- If no PR was created (stopped before step 5), say so explicitly instead of emitting a URL.

## Skill chain (full)

```text
lh-dev → lh-pr-review → lh-merge-ready → (human merge)
```

## PR creation outside this skill

If you create a LoopHub PR without running this skill (ad-hoc fix, exploratory branch, side task),
**still include the Evidence section** in the PR body (step 5 template) and **still run the review chain
in the same session**:

```text
/lh-pr-review <m> → /lh-merge-ready <m>
```

Do not stop at commit or `lh pr create` alone. See `skills/README.md` § Skill chain.

## Conflicts

On the worktree head: `git rebase main` (or `merge main`) → commit. lh-web sweeps open-PR head
SHAs and auto-fires `pull_request.updated`, so no manual sync is needed.

## Prohibited

- Do not merge
- Do not work on main
- Do not edit source outside the issue worktree (`lh dev` starts you inside it; on a manual launch, `cd`
  into the worktree first)
- Do not auto-start after issue creation without consent (startup guard violation)
- Do not "implement while you're here" without user confirmation
- Do not end the session after PR creation without step 7 (review loop) unless the user said "stop at PR"
- Do not treat step 6 Report as completion — it is not the final step
- Do not end the response without the PR URL as the final line (step 9), at any exit point
