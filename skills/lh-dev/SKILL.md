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

Do not take ownership of the issue (open the linked PR), create a worktree, or edit source until the
user chooses implementation.

## Invocation

`/lh-dev <issue id>` — take the issue number from the argument and start on it directly (**no
selection UI**). If the id is **omitted**, present a selection UI (see § Selecting an issue).

**If the startup guard is not satisfied, stop here** — even if you know the issue number.

See `skills/README.md` (skill naming) for why this skill does not use a `loop-` prefix.

### Selecting an issue (no id given)

When `/lh-dev` is run **without** an issue id, do not guess — let the user pick via the built-in
`AskUserQuestion` UI:

1. **A just-created issue takes priority.** If an issue was created earlier in *this same
   conversation* (e.g. via `lh-issue-create`) and the user clearly means it, start on that issue
   directly and skip the selection UI. If it is ambiguous, put that issue **first** in the options
   below.
2. **Fetch candidates** — open, `ready-to-build`, no linked PR yet, newest first:

   ```sh
   lh issue list --repo <repo> --json \
     | jq -r '[.[]
         | select((.labels // [] | map(.name) | index("ready-to-build"))
             and ((.linked_pull_request | not) or (.linked_pull_request.state != "open")))]
         | sort_by(.updated_at) | reverse | .[0:4]
         | .[] | "#\(.number)\t\(.title)"'
   ```

   `lh issue list` defaults to `--state open` and already drops PRs; the `jq` keeps only
   `ready-to-build` issues that have **no open linked PR** (an issue whose only PR was closed
   without merging — an abandoned attempt — stays a candidate), sorts by `updated_at` descending,
   and takes the **top 4**.
3. **Ask with `AskUserQuestion`** — one question, the top **3–4** candidates as options. Each option
   label is the issue `#number — title` (add a label chip when useful). `AskUserQuestion` always
   appends an **"Other"** entry: tell the user they can type any issue number there if the one they
   want is not listed. The 3–4 shown cover the common case; "Other" covers the long tail (full list
   via `lh issue list`).
4. **On selection**, take the chosen issue number (or the number typed into "Other") and continue the
   normal flow (§1 onward) for that issue.

If no candidate issues are found (empty list), say so and ask the user for an issue number directly.

## Called from other skills

| Caller | Continue? |
|--------|-----------|
| `lh-issue-create` / `lh-plan-to-issues` / `to-issues` | ❌ No auto-continue; separate explicit user request only |
| LoopHub dispatch / cron | ✅ Start issue-dev |

## LoopHub

See `skills/README.md` § LoopHub basics for server / CLI / `--repo` defaults.

- `--session-id` — attribution for comments and other writes (`lh dev` attributes the session to the linked PR row for you)

### Web URL (for reporting)

Always show the user a UI URL when reporting (no CLI output changes required).

| Kind | Format |
|------|--------|
| issue | `{baseUrl}/r/{owner}/{repo}/issues/{n}` |
| PR | `{baseUrl}/r/{owner}/{repo}/pulls/{m}` |

See `skills/README.md` § Web URL / baseUrl resolution for how `baseUrl` is computed.

Example: `http://localhost:8730/r/jugyo/local-github/issues/73`

## Language

This skill is English. **Reader-facing output** — PR title/body headings, user-facing summaries,
`review_notes`, and `lh dev note` hand-off text — must match the **PR's language**. Code, CLI,
identifiers, and commit messages stay English.

Resolve the target language once, taking the first that applies: (1) the **linked issue**'s language
(§1 already reads it — the primary signal, since the PR exists to satisfy that issue); (2) the
human-authored part of the **PR body/title** (ignore tooling boilerplate like the empty draft
placeholder and `Closes #n`); (3) the **conversation language**; (4) **English** as the fallback when
none is determinable. Use the resolved language for every generated artifact in this flow.

`review_notes` are a special case: their *content* is generated from the diff only (no PR/issue prose,
to avoid biasing the factual summary — see #205), but the *language* still follows the resolved PR
language, passed as a formatting directive ("write the summary in `<lang>`") rather than by feeding
issue/PR text into the content input.

## Procedure

### 1. Before starting implementation (mandatory)

```sh
lh issue view <n> --repo <repo>
```

**Also read the issue's comments** — design memos are often left in comments, not only the body
(#231). The plain view shows only the body, so pull the comment bodies from `--json` (`comment_list`:
author, time, text):

```sh
lh issue view <n> --repo <repo> --json \
  | jq -r '.comment_list[]? | "--- @\(.user.login) (\(.created_at))\n\(.body)"'
```

Treat both body **and** comments as the implementation spec. Comments may also carry progress notes or
chatter — read for design intent (decisions, scope changes, constraints) and ignore pure status/noise;
when a comment contradicts the body, the **later** statement wins. If body and comments conflict in a
way you can't resolve, flag it rather than guess.

**Before editing source**, show the user a short overview:

- **#n** — title
- **Goal**: done criteria (1–3 sentences)
- **Acceptance criteria**: pull in the issue's AC (the checklist mirrored into the PR body at step 5)
- **Out of scope**: if any
- **Issue URL** — Web URL format above as a markdown link for the user

Do not proceed to step 2 until this summary is written (in the chat response for interactive sessions,
or in the session log for AFK/cron).

### 2. Worktree & session (already provisioned by `lh dev`)

When launched via `lh dev <n>`, the session **starts already inside the PR worktree** with the setup
below done for you — do **not** redo it:

- **Worktree**: provisioned at `~/.loophub/worktrees/<owner>/<repo>/pr-<m>` on branch
  `loophub/pr-<m>` (off `main`) — keyed by the **linked PR's number** `<m>`, not the issue number
  (#463: `lh dev` opens the PR first and derives the branch/worktree name from it, so two PRs for
  the same issue never collide); the session's cwd is already there.
- **Session**: registered (agent `lh-dev`). The dev session is attributed to the **PR row**
  (`pulls.session_id`) when `lh dev` opens or re-enters the PR — that is what `lh resume` / retro
  resolve from. There is no issue-assignee step (removed in #186); "who is working this issue" is the
  linked PR's existence, not a separate assignee.
- **Draft PR**: `lh dev` **already opened a linked PR** for this issue at the start of work (idempotent;
  see `core/service.ts` `dev.openPr`). It is a normal open PR with a placeholder body (a localized
  implementation-plan heading plus `Closes #<n>`) and may have 0 commits. **A linked PR already
  existing is the expected state, not an
  anomaly** — do not be surprised by it, do not create a second one, and do not stop to ask about it.
  You fill in its body at §5.

So skip straight to implementing (§3). Verify the setup once:

```sh
git status                          # tree clean; on branch loophub/pr-<m>
git rev-parse --abbrev-ref HEAD     # loophub/pr-<m>  (<m> = linked PR number)
```

Inside the worktree, **`--repo owner/name` is required** for every `lh` call — the worktree lives
outside the main checkout, so `resolveRepo()` cannot infer the repo from cwd.

Progress is already visible via the linked PR; post `lh issue comment <n> --repo <repo>` only if you
need to flag a blocker or hand-off for a human watching the UI.

#### Another session already owns the issue

The double-`lh dev` guard is a **soft open-PR check** (at most one open PR per linked issue; not a DB
constraint, so it can be relaxed later for multiple proposal PRs) plus the host-local dev lock — `lh
dev` is idempotent and reuses the existing open PR rather than opening a second. But if you find a
**different active session** is genuinely working the same issue (not just a
stale re-launch of your own), **stop** and ask the human whether to wait, pick another issue, or take
over. Do not edit in parallel.

#### Manual launch (not via `lh dev`)

Only if you arrived here **without** `lh dev` (ad-hoc, or a host that doesn't use the launcher): set up
the worktree and the linked draft PR yourself first, then continue. `lh dev openPr` records the session
on the PR (`pulls.session_id`); there is no separate assign step.

```sh
# `lh dev` derives the branch/worktree name from the PR number (`loophub/pr-<m>`), which is not
# known until the PR row exists — a manual launch can't reproduce that, so pick a branch name
# yourself (any name works; `--head` below just has to match it).
git worktree add ~/.loophub/worktrees/<owner>/<repo>/<branch> -b <branch> main
cd ~/.loophub/worktrees/<owner>/<repo>/<branch>
SID="$(uuidgen)"
lh session register --id "$SID" --agent impl-bot --session "$SID"
# Open the linked draft PR. `--session-id "$SID"` attributes the session to the PR row
# (`pulls.session_id`) — the basis for `lh resume` / retro. The soft open-PR check makes this the
# point at which the issue is "taken": a second open PR for the same issue is refused (422).
lh pr create --repo <repo> --head <branch> --base main --title "..." --issue <n> --session-id "$SID"
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

#### Record key decisions (optional, for later retro)

When you make a judgement that won't be obvious from the diff or PR body — a scope call, a step
deliberately skipped, a non-obvious tradeoff — record it so a later `/lh-retro` can recover the
*why* (design §4.3.4, `docs/loop-retrospective-design.ja.md`):

```sh
lh dev note --kind decision --summary "<what you decided>" --body "<why>" --pr <m> --repo <repo>
```

`--kind` is one of `decision|action|assumption|blocker`. This emits a small `dev.note` event (stored
in the `events` table — no transcript). **Non-blocking: a failed note must never stop implementation.**
Don't add notes routinely; reserve them for judgements that won't surface in the diff/PR body. Inside a
worktree `--repo owner/name` is required.

**Redaction**: `--summary` / `--body` must hold a *redacted rationale only* — state the decision and
why in your own words. Never paste tool output, file contents, credentials/tokens, env dumps, or
absolute paths into them. The note is stored at-rest and is later read by `/lh-retro`, so a secret
pasted here persists and can flow into retro findings.

### 4. Test

Use the repo standard command (e.g. `npm test`). **Green before PR.**

While testing, **capture evidence for the PR body** (step 5):

- Save the command and a short excerpt of green output (pass/fail counts, key lines)
- For UI or visual changes, take screenshots before opening the PR (browser tool, manual capture, or
  generated assets under the repo) and save them to the **persistent evidence directory**
  (`${LOOPHUB_HOME:-$HOME/.loophub}/evidence/<owner>/<repo>/issue-<n>/`; see `skills/README.md` §
  Evidence screenshots) — **not only** the session scratchpad / `$TMPDIR` or the worktree, which can be
  cleared before `lh-merge-ready` reads them. **Keep the persistent-dir copy** (`lh-merge-ready` reads
  those paths), and **also upload it for inline display in the PR**: run

  ```sh
  lh attachment add --file <path> [--file <path> ...]   # one printed line per file
  ```

  which prints embed markdown `![<name>](/attachments/<sha256>)` (one line per `--file`). Paste those
  printed lines into the PR body's Evidence section (step 5) so the images render inline on the PR —
  do **not** paste the filesystem path. Saving to the persistent dir and attaching for the PR are both
  required, not either/or. **Before uploading**, confirm the screenshot/snippet contains no secrets
  (`.env` values, tokens, `Authorization` headers, cookies, PII) — attachments are content-addressed,
  immutable, and never garbage-collected, so a leaked secret cannot be revoked; mask or re-capture if
  in doubt.
- For CLI/API fixes, paste a representative command and response snippet

Do not open a PR with checkboxes only — reviewers need proof you ran the verification.

### 5. PR (fill the existing draft PR)

No push required (LoopHub reads the same `.git` directly). Default uses the production server (`:8730`).

**`lh dev` already opened a linked PR at the start of work (§2).** Your job here is **not** to create a
PR — it is to **fill in that PR's body** with the real Summary / Acceptance criteria / Test plan /
Evidence, replacing the placeholder implementation-plan body that `lh dev` generated. `lh dev` opened
the PR as a **draft** (#413), so it is already open but still marked WIP; filling the body **and**
flipping it to ready (the closing step below) is what readies it for review (§7). Do **not** run
`lh pr create` on the normal path — that would create a duplicate.

First get the PR number (it is shown by `lh issue view`, or list open PRs for the branch):

```sh
lh issue view <n> --repo <repo>     # header shows: linked PR #<m> (open)
# or read it off the worktree branch: git rev-parse --abbrev-ref HEAD → loophub/pr-<m>
```

**`--body` is required.** Do not leave the placeholder body — fill all required sections below.

#### Body template (required sections)

Match heading language to the **PR's language** (localized Summary / Acceptance criteria / Test plan /
Evidence headings) — see [§ Language](#language) for how it is resolved. Update the existing PR's body
via HEREDOC:

```sh
lh pr update <m> --repo <repo> \
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
- **UI / visual** (when applicable): embed markdown from `lh attachment add --file <path>` (`![name](/attachments/<sha256>)`), so it renders inline — not a filesystem path; one line on what it shows
- **CLI / API** (when applicable): command + representative output snippet
- **N/A** (docs-only / trivial): one line why substantive evidence does not apply — do not omit this section

Closes #<n>
EOF
)"
```

When running a **parallel server** in the worktree (§2 `lh-web --port 8731`), prefix
`LOOPHUB_URL=http://localhost:8731` on the same command — the `--body` heredoc is identical to the one
above.

| Required | Content |
|----------|---------|
| Summary | What changed and why (1–3 bullets) |
| Acceptance criteria | Mirror the issue's AC as a checklist; check **only** items this PR actually satisfies (unmet / out-of-scope stay unchecked with a one-line reason) |
| Test plan | Verification performed (checked items you actually ran) |
| Evidence | Concrete proof from step 4 — test output excerpt, screenshots, CLI snippets, or explicit N/A |
| `Closes #<n>` | Issue number — already in the placeholder body from `lh dev`; keep it |

The **Acceptance criteria** section mirrors the issue's AC verbatim as a checklist. Tick an item only
when the PR genuinely meets it; leave anything unmet or out of scope unchecked and append a one-line
reason. This is the human- and reviewer-facing record that the PR satisfies the issue — `lh-pr-review`
runs an Acceptance reviewer against the same AC.

The issue↔PR link and `Closes #<n>` were set when `lh dev` opened the draft PR, so you do not pass
`--issue` to `lh pr update`. Keep `Closes #<n>` in the body. No manual issue comment needed.

#### Fallback: no linked PR exists

The draft PR is normally already there (§2). Only if `lh issue view <n>` shows **no linked PR** (e.g.
`lh dev` failed before opening it, or a manual launch) do you create one yourself — this is the
exception, not the default path:

```sh
# --head is the worktree's current branch (git rev-parse --abbrev-ref HEAD)
lh pr create --repo <repo> --head <branch> --base main \
  --title "..." --issue <n> --actor impl-bot \
  --body "$(cat <<'EOF'
... same required sections as above ...
Closes #<n>
EOF
)"
```

After updating (or creating), confirm the body is non-empty:

```sh
lh pr view <m> --repo <repo>   # body must include Summary, Acceptance criteria, Test plan, and Evidence
```

#### Evidence rules

| Change type | Minimum evidence |
|-------------|------------------|
| Code / tests | Test command + green output excerpt (not "ran tests") |
| UI / UX | Screenshot uploaded via `lh attachment add` → embed markdown (`![name](/attachments/<sha256>)`) + caption |
| CLI / API | Command + representative output |
| Docs / skills only | Evidence section with **N/A** and one-line rationale |

Empty Evidence or placeholder bullets (`TBD`, `TODO`, unchecked test plan only) → fix the body before
step 6.

#### Mark the PR ready for review (draft → ready)

`lh dev` opened this PR as a **draft** (#413) — the WIP marker for "still being implemented". Filling the
body with real Summary / Acceptance criteria / Test plan / Evidence on a green tree **is** implementation
completion, so flip the draft to ready here, as the closing action of §5:

```sh
lh pr ready-for-review <m> --repo <repo>   # draft → ready; fires pull_request.ready_for_review
```

When running a **parallel server** (§2), prefix `LOOPHUB_URL=http://localhost:8731`. This clears the
draft flag so the PR reads as **ready** in events and `lh pr list` / view — distinguishing it from a PR
left in draft (an abandoned WIP attempt). This is the draft→ready transition only; `lh pr ready-for-review`
also has a *re-review after change requests* mode, but the lh-dev flow does not use it (§7 delegates to
`lh-pr-review`, which re-reviews by re-running its reviewers, posting `lh pr comment` only for
visibility).

Run this **only when the PR is still a draft** — i.e. the normal `lh dev` path, where it succeeds. Do
**not** skip it there when going straight to review: `lh-pr-review` should run against a ready PR, and a
PR left in draft signals "implementation not finished". On the fallback path where you created the PR
yourself **non-draft** (§5 "no linked PR exists"), it is already ready — **skip this step**: running
`lh pr ready-for-review` on a non-draft PR with no pending change requests **exits non-zero**
(`error 422: No pending change requests to address`), it is not a benign no-op.

### 6. Report

Goal summary / changed files / test results / PR number / **PR URL** (Web URL format as markdown link) /
**PR description written** (confirm non-empty body with Evidence via `lh pr view`) / **PR status ready**
(no longer draft after §5's `lh pr ready-for-review`)

**Do not end the session here.** Step 6 is a checkpoint only — **step 7 (Review loop) is mandatory**
unless the user said "stop at PR". Proceed immediately to `/lh-pr-review <m>` without waiting
for another user message.

### 7. Review loop (default, same session)

After filling in the PR body (§5), **without ending this session**, continue with `lh-pr-review`:

```text
/lh-pr-review <m>
```

Bugbot + Security review → fix on head in this session if needed → re-review until `pass`. See
`skills/lh-pr-review/SKILL.md`.

Skip only if the user said "stop at PR".

### 8. merge-ready (after pass, same session)

When `lh-pr-review` returns `pass`, **without ending this session**, pre-merge check:

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
- Do not edit source outside the PR worktree (`lh dev` starts you inside it; on a manual launch, `cd`
  into the worktree first)
- Do not auto-start after issue creation without consent (startup guard violation)
- Do not "implement while you're here" without user confirmation
- Do not end the session after PR creation without step 7 (review loop) unless the user said "stop at PR"
- Do not treat step 6 Report as completion — it is not the final step
- Do not end the response without the PR URL as the final line (step 9), at any exit point
