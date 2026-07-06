---
name: lh-pr-review
description: >-
  Review a LoopHub PR with quality, security, documentation, and acceptance reviewers, selected by
  what the PR diff changes (host-mapped isolated reviewer sessions), fix findings on the head branch,
  and re-review until pass. Use when the user runs /lh-pr-review {pr id}, when asked to review a
  LoopHub PR, or after issue-dev creates a PR. Posts a per-topic lh pr review each round. Does not merge. Add
  --review-only for a single review without the fix loop.
---

# LoopHub PR review

Review a PR with up to four reviewers — **quality, security, documentation, acceptance** (run as
readonly, context-isolated reviewer sessions mapped to whatever the host provides) — **selected by what
the PR diff actually changes**, per [Review selection policy](#review-selection-policy); if findings
exist, **fix on head in this session (parent agent)** → test → **re-review** until **`pass`**. Do not
merge.

Vendor-agnostic by design: the reviewer **roles** are fixed, but their **mechanism** is resolved per
host (Codex, Cursor, Claude Code, ...). See [Reviewer roles & host mapping](#reviewer-roles--host-mapping).

Distinct from Cursor's built-in `/loop` (scheduled wake). Here, "loop" means **review → fix → review**.

## Invocation

```text
/lh-pr-review <pr id>              # loop enabled (default)
/lh-pr-review <pr id> --review-only   # single review (no fix loop)
/lh-pr-review <pr id> --max-rounds 8  # max rounds (default 5)
/lh-pr-review                      # resolve PR from session context (see below)
```

### PR number resolution (when `<pr id>` omitted)

**Default:** infer the target PR when **obvious** from session context. Ask the user only when
**not obvious**. Dispatch / cron must pass `<pr id>` explicitly (no inference).

Before starting review, state the chosen PR in one line (prevents silent wrong-target review):

```text
Reviewing PR #<m>: <title>
```

#### Obvious (infer without asking)

Any **one** of these alone is enough:

| Signal | Example |
|--------|---------|
| Same-session issue-dev just created the PR | `lh pr create ...` returned `#42` in this chat |
| PR already loaded in this session | `lh pr view <m>` or `/lh-pr-review <m>` earlier in chat |
| User named the PR in the immediately preceding message | "review this" right after posting PR #42 URL |
| Linked issue maps to exactly one open PR | `lh issue view <n>` → `linked_pull_request`, or single open PR with `--issue <n>` |

If multiple signals agree on the same `<m>`, use it. If they disagree, treat as **not obvious**.

#### Not obvious (ask the user)

- Two or more open PRs and no single signal above
- No PR created yet in this session (issue-dev stopped before PR, etc.)
- Conversation switched to a different PR or issue since the last clear target
- Signals point to different PR numbers

```text
Which PR should I review? (e.g. /lh-pr-review 42)
```

## Role split

| Role | Owner |
|------|-------|
| Loop control, fixes | **Parent (this session)** |
| LoopHub context | Parent |
| Checkout head branch | Parent |
| Quality review (bugs, correctness) | Quality reviewer session (host-mapped) |
| Security review | Security reviewer session (host-mapped) |
| Documentation review (reader fit) | Documentation reviewer session (generic reviewer + Documentation prompt) |
| Acceptance review (issue requirement / spec / AC) | Acceptance reviewer session (generic reviewer + Acceptance prompt) |
| Issue scope alignment, test check | Parent |
| Code fixes, commits | **Parent (fix phase only)** |
| Post `lh pr review --topic <aspect>` | Parent (**once per topic per round** — see A.5) |

Reviewer sessions are **readonly** — **no fixes**, **no posts**. They are launched through a
host-specific mechanism that must not inherit the parent conversation history; the concrete mechanism is
chosen at runtime per [Reviewer roles & host mapping](#reviewer-roles--host-mapping).

## Reviewer roles & host mapping

Reviews are defined by **role**, never by a vendor product name. Which roles run each round is decided
by the PR diff's content and metadata ([Review selection policy](#review-selection-policy) below),
re-evaluated every round from A.1 / A.3 / A.4:

| Role | Looks for |
|------|-----------|
| **Quality** | correctness bugs, logic errors, regressions, missed edge cases, broken contracts |
| **Security** | injection, auth/authz gaps, secret/credential exposure, unsafe input handling, supply-chain risk |
| **Documentation** | reader fit for changed documentation: intended audience, natural reading flow, leaked internal details, information order |
| **Acceptance** | unmet acceptance criteria, requirement/spec gaps, behavior that contradicts the linked issue |

### Review selection policy

| Role | Runs when | Skipped when |
|------|-----------|---------------|
| Quality | diff includes a non-documentation (code) file, **or** the diff touches `skills/` (A.2.5 skills-lint) | diff is documentation-only and does not touch `skills/` |
| Security | diff includes a non-documentation (code) file | diff is documentation-only |
| Documentation | diff includes at least one documentation file (`README*`, `*.md`, `skills/**/SKILL.md`) | diff has no documentation file |
| Acceptance | PR has a linked issue | no linked issue |

Each role's trigger is independent, so a diff mixing code and documentation changes runs **all four**
applicable roles — code changes pull in Quality/Security, documentation changes pull in Documentation,
and a linked issue pulls in Acceptance, regardless of what the other roles' triggers found. A
documentation-only diff that does not touch `skills/` (a plain README-only PR, for example) skips
Quality and Security, since there is no code surface for correctness or security review; running them
anyway is exactly the excess review noise this policy avoids. A code-only diff with no documentation
files skips Documentation.

**Exception — `skills/` diffs**: `skills/**/SKILL.md` is classified as documentation (A.1), so a
skills-only diff is otherwise documentation-only. But Quality still runs whenever the diff touches
`skills/`, even if nothing else in the diff is code — the skills-lint check (A.2.5) is scoped to the
`quality` topic, and it needs that topic active to report a lint failure. Security has no such check, so
it keeps the plain documentation-only skip.

The diff classification that drives this table (`hasCodeChanges` / `hasDocChanges` / `touchesSkills`) is
computed in A.1; role selection is applied in A.3; which roles ran or were skipped, and why, is recorded
in the A.4 synthesis and surfaced in the A.6 round report — that record is the audit trail for "why this
review set ran."

### Capability detection (pick the best available mechanism)

At launch, map each role to the **first available** mechanism for the current host, degrading left to
right. Never hard-fail because a vendor-specific reviewer is absent — always run **every role selected
by** [Review selection policy](#review-selection-policy) via *some* readonly reviewer session.

**Context isolation is mandatory.** Reviewer launch must use a mechanism that starts from a fresh
context and receives only the reviewer role prompt, objective repository references (repository path,
base branch, and `lh pr diff` output), and role-specific inputs. Do not pass the parent conversation
transcript, implementation notes, test logs, or the implementer's self-summary. Do not launch reviewers
as forks of the parent conversation. A host path that can only fork the parent history is allowed only
as a degraded fallback, and the A.4 review body must explicitly say `degraded: inherited parent
history` for that role.

| Role | Codex | Cursor | Claude Code | Generic fallback (any host) |
|------|-------|--------|-------------|------------------------------|
| Quality | fresh non-interactive `codex exec` session + Quality prompt + diff | isolated `subagent_type: "bugbot"` + diff | isolated `subagent_type: "code-reviewer"` + diff if present, else isolated `general-purpose` + Quality prompt + diff | isolated `general-purpose` reviewer + Quality prompt + diff |
| Security | fresh non-interactive `codex exec` session + Security prompt + diff | isolated `subagent_type: "security-review"` + diff | isolated `general-purpose` running the `/security-review` skill + diff — fall back to a `code-review` security pass only if `/security-review` is unavailable | isolated `general-purpose` reviewer + Security prompt + diff |
| Documentation | fresh non-interactive `codex exec` session + Documentation prompt + diff | isolated `general-purpose` + Documentation prompt + diff | isolated `general-purpose` + Documentation prompt + diff | isolated `general-purpose` reviewer + Documentation prompt + diff |
| Acceptance | fresh non-interactive `codex exec` session + Acceptance prompt + diff + linked issue Goal/AC | isolated `general-purpose` + Acceptance prompt + diff + linked issue Goal/AC | isolated `general-purpose` + Acceptance prompt + diff + linked issue Goal/AC | isolated `general-purpose` reviewer + Acceptance prompt + diff + linked issue Goal/AC |

Documentation and Acceptance are **not** vendor products — there are no specialized reviewers for them.
On every host they run as generic isolated reviewers fed the Documentation and Acceptance prompts
(A.3), when [Review selection policy](#review-selection-policy) selects them.

Detection rule: if the named reviewer type is unavailable in this host, fall to the next column. The
**prompt and expected output below are identical** regardless of which mechanism wins, so synthesis
(A.4) does not depend on the host.

Codex reviewer launch uses `codex exec` in non-interactive mode. Feed the complete reviewer prompt on
stdin, set the reviewer cwd to the PR worktree, prefer read-only sandboxing, and use `--ephemeral` so
the review does not create a resumable child conversation:

```sh
codex exec --cd "<worktree>" --sandbox read-only --ephemeral --json \
  --output-last-message "/tmp/lh-pr-<m>-<role>.json" -
```

Claude Code Task subagents have their own context window and return only their final result to the
caller. Treat that as the normal isolated path, but still include the full diff in the task prompt so
the reviewer does not need the parent transcript to reconstruct scope.

**Record what actually ran.** Whichever mechanism each role resolves to, name it in the A.4 review body
(e.g. `Security: general-purpose + Security prompt — degraded`). A degraded path is allowed (review must
never hard-fail on a missing vendor reviewer), but it must be **visible** so a human can judge whether a
weaker pass was acceptable. Prefer the strongest available mechanism for the Security role —
`security-review` / `/security-review` over a generic `code-review` pass, which is correctness-focused.

## LoopHub

- **Server**: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh` (on PATH)
- **`--repo owner/name`**: omit only when cwd is the repo root; required inside a worktree
- **Auto-sync**: `lh-web` sweeps open PRs' head SHAs and auto-fires `pull_request.updated` — after
  committing, rebasing, or merging on a PR head, no manual sync call is needed
- `--actor reviewer-bot` (review posts) / `--actor impl-bot` (fix comments, etc.)

## Language

**Review output read by humans** — the `lh pr review` body (Verdict / Scope /
Reviewers / per-role sections) and every line comment — must match the **PR's language**. Code, CLI,
identifiers, and severity keywords (`pass` / `request_changes` / `comment`) stay English.

Resolve the target language once in A.1 (which already reads the PR and, when linked, the issue),
taking the first that applies: (1) the **linked issue**'s language (the primary signal); (2) the
human-authored part of the **PR body/title** (ignore tooling boilerplate); (3) the **conversation
language**; (4) **English** as the fallback when none is determinable. The reviewer sessions return
structured JSON regardless; the parent localizes the prose when synthesizing (A.4) and posting (A.5).

## Full loop

```text
round = 1
while round <= max_rounds:
  A. Review (steps 1–6) → per-topic verdicts → overall verdict (A.4)
  if overall == pass:           # only when EVERY topic that ran is pass
    report completion and exit
  if --review-only:
    report and exit (no fixes)
  B. Fix (step 7) — parent on head
  if unfixable blocker:
    report and exit
  round += 1
report: max_rounds reached; escalate to human
```

Each round posts one review **per topic** (quality / security / documentation / acceptance, as
applicable), and aggregates them into a single **overall verdict** that drives the loop:
`request_changes` if **any** topic requests changes, `comment` when only non-blocking findings remain,
and `pass` only when **every** topic that ran is pass. Only `pass` exits the loop (see A.4 / A.5).

Default `max_rounds` **5**. Stop loop if the same finding persists two rounds in a row; escalate.

## Phase A — Review (each round)

Do **not** edit code during review (before or after reviewer launch).

### A.1 Context (parent)

```sh
lh pr view <m> --repo <repo>
lh pr diff <m> --repo <repo>
```

If `linked_issue` exists, read the issue too (`lh pr view` output or API):

```sh
lh issue view <n> --repo <repo>
```

Record: PR number / title / `head.ref` / `base.ref` / repo absolute path / linked issue goal (if any) /
round number / the diff's file classification (below).

Classify every changed path from `lh pr diff` as **documentation** or **code**:

- `README`, `README.*`, and any path segment exactly equal to `README` or starting with `README.`
- `*.md`, including files under `docs/`
- `skills/**/SKILL.md`

A changed path matching one of those rules is a documentation file; every other changed path is a code
file. Derive three flags from this classification and carry them into A.3:

- `hasDocChanges` — at least one changed path is a documentation file
- `hasCodeChanges` — at least one changed path is **not** a documentation file
- `touchesSkills` — at least one changed path starts with `skills/`

These flags, plus whether the PR has a linked issue, are exactly the inputs [Review selection
policy](#review-selection-policy) gates on — apply that table in A.3.

### A.2 Head worktree (parent)

**Do not `git checkout head.ref` on the main checkout.** Bootstrap a worktree on the PR head instead:

1. Record `head.ref` and repo absolute path (`local_path`) from `lh pr view <m>` (A.1). For `lh dev`
   PRs the head is `loophub/pr-<m>`, and its worktree usually already exists at
   `~/.loophub/worktrees/<owner>/<repo>/pr-<m>`.
2. If a worktree already has `head.ref` checked out — the session's cwd (e.g. issue-dev → pr-review
   chain), or the `lh dev` worktree above (`git worktree list`) — use that one (adding a second
   worktree for a checked-out branch fails).
3. Else `cd local_path` and check `.worktrees/<head.ref>`: exists → `cd` into it; missing →
   `git worktree add .worktrees/<head.ref> <head.ref>` then `cd`.

```sh
ROOT="<local_path>"
WT="$ROOT/.worktrees/<head.ref>"
if [ "$(pwd -P)" = "$(cd "$WT" 2>/dev/null && pwd -P)" ]; then
  : # already in target worktree (e.g. issue-dev → pr-review chain)
elif [ -d "$WT" ]; then
  cd "$WT"
else
  git -C "$ROOT" worktree add ".worktrees/<head.ref>" <head.ref> && cd "$WT"
fi
```

- Cannot add worktree (dirty / conflict) → blocker. Stash only after user confirmation
- Pass `--repo owner/name` on all CLI calls from inside the worktree (`resolveRepo()` omits it only
  when cwd is the repo root)
- Pass the **working cwd (worktree absolute path)** as the reviewer sessions' repository path (see
  [reviewer-prompts.md](reviewer-prompts.md), "Repository path")

### A.2.5 Skills lint (parent, when PR touches `skills/`)

If `lh pr diff` includes changes under `skills/` and `tests/skills-lint.test.ts` exists:

```sh
bun test tests/skills-lint.test.ts
```

Any failure → **`request_changes`** (do not `pass`). Report file:line from test output. If the file does
not exist, record `skills-lint: skipped (tests/skills-lint.test.ts not present)` in the Quality review's
Tests section instead of failing the topic. (This is why [Review selection
policy](#review-selection-policy) keeps Quality active on a skills-only diff.)

LoopHub skills are **English-only in the body** (after YAML frontmatter). CJK in `description` is allowed
for routing triggers. Localized issue/PR templates belong in user output, not in skill files.

### A.3 Launch reviewers in parallel (parent)

Apply [Review selection policy](#review-selection-policy) to A.1's `hasCodeChanges` / `hasDocChanges` /
`touchesSkills` flags and linked-issue presence to decide which of **Quality**, **Security**,
**Documentation**, **Acceptance** run this round. Launch the selected roles as **readonly,
context-isolated reviewer sessions in parallel**; each runs once per round. Record which roles were
skipped, and why, for A.4. Resolve each launched role's mechanism via
[Reviewer roles & host mapping](#reviewer-roles--host-mapping) — e.g. on Codex, separate
non-interactive `codex exec` invocations; on Cursor, `bugbot` / `security-review` / `general-purpose` /
`general-purpose`; on Claude Code, isolated Task subagents using `code-reviewer` (or
`general-purpose`) / `general-purpose` running `/security-review` / `general-purpose` /
`general-purpose`.
`description: "<Quality|Security|Documentation|Acceptance> review PR #<m> round <round>"`.

Load each launched role's full prompt text from
[`reviewer-prompts.md`](reviewer-prompts.md) — one shared Quality/Security prompt, plus a distinct
Documentation prompt (fed the changed documentation files) and Acceptance prompt (fed the linked
issue's Goal and AC). Append the full `lh pr diff <m> --repo <repo>` output to every reviewer prompt.
The parent may also include a compact metadata header (PR number, base/head refs, changed path list,
round), but must not include the parent conversation transcript, implementation notes, test logs, the
implementer's self-summary, or any other inherited history. Do not restrict the reviewers' independent
repository exploration; the diff is the starting scope and objective input, not a ban on reading related
files when needed. All three return the same findings JSON shape.

Structured JSON output keeps A.4 merge/dedupe deterministic across hosts. If a host cannot pass the
literal diff body to the reviewer, mark that role as degraded in A.4 and substitute a natural-language
change description; the JSON return shape is unchanged.

On failure: retry once (re-resolve to the next mechanism in the mapping if the reviewer type itself is
the failure).

#### Optional: false-positive filter (high-noise diffs)

When a reviewer returns many low-confidence findings, run a brief **adversarial verify** pass before
posting: spawn one readonly skeptic reviewer session (any available isolated type) prompted to *refute* each
borderline finding (`{ "kept": bool, "reason": "<why>" }`). Guardrails so real signal is never lost:

- **Never delete.** Refuted findings are not dropped — move them to a **`suppressed (low-confidence)`**
  list and include that list in the A.4 synthesis output so a human can still see them.
- **Security-role, Documentation-role, and Acceptance-role findings are never suppressed** by this pass
  — only Quality findings are eligible.
- **Severity is owned by the original reviewer.** The skeptic may mark `kept:false`, but may not lower a
  finding's severity. All Critical/High stay in the active set regardless of the skeptic.

Skip this pass entirely when findings are few or clearly real.

### A.4 Synthesize per topic (parent)

Reviews are posted **per topic** (#209: `lh pr review --topic <aspect>`). Keep each role's findings in
its **own** topic bucket — `quality`, `security`, `documentation`, `acceptance` — instead of merging
them into one body.

1. **Scope** (round-wide): Does PR match the issue goal? One or two sentences reused in each topic body.
2. **Per-topic findings**: keep Quality / Security / Documentation / Acceptance findings separate, each
   by severity. The Quality-only false-positive filter (A.3) applies to the `quality` bucket only. A
   role A.3 skipped this round has **no** bucket — its topic is simply not posted in A.5.
3. **Per-topic verdict** — decide each topic on its **own** findings:

   | Topic | `request_changes` when | `comment` when | `pass` when |
   |-------|------------------------|----------------|-------------|
   | `quality` | unresolved Critical / High, **or** skills lint failed (A.2.5) | only Medium / Low findings remain | no findings and lint passed |
   | `security` | unresolved Critical / High | only Medium / Low findings remain | no findings |
   | `documentation` | unresolved Critical / High reader-fit problem | only Medium / Low reader-fit findings remain | no reader-fit findings |
   | `acceptance` | any unmet AC item or behavior contradicting the issue's spec | non-blocking requirement note only | every AC item met |

   Skills lint failure (A.2.5) belongs to the **quality** topic — it forces `quality` to
   `request_changes`.
4. **Overall verdict** (round-wide, drives the loop): `request_changes` if **any** topic is
   `request_changes`; else `comment` if any topic is `comment`; else `pass` (every topic that ran is
   pass). Only `pass` exits the loop.

Per-topic `--body` template (one per topic; include round number and the same Scope line):

```markdown
## <Quality|Security|Documentation|Acceptance> — Verdict: <pass|request_changes|comment>
Round: <n>/<max_rounds>
Reviewer: <mechanism this role actually ran — note "degraded" if a fallback was used>

### Scope
<shared 1–2 sentences on issue alignment>

### Findings
<this topic's finding count + summary, or "none">
<quality only: note any suppressed low-confidence items>
<documentation only: note intended reader and whether ordering/details fit that reader>
<acceptance only: per-AC pass/fail against the issue>

### Tests
<commands run and results; the quality body includes skills-lint when skills/ changed>
```

### A.5 Post per topic (parent, required each round)

Post **one review per topic that ran** this round (per A.3's launch decisions), each tagged with
`--topic` and carrying that topic's own verdict, body, and line comments. **Once per topic per round** —
never post the same topic twice in one round (the per-round double-post guard now applies per topic;
multiple rounds across the loop are still fine).

**Posting order matters.** A PR's resolved review state is the **latest substantive (pass /
request_changes) review regardless of topic** (`core/store.ts` `latestSubstantiveReview` /
`computeReviewState`). So post topics whose verdict is `pass` or `comment` **first**, and any
`request_changes` topic **last**. This guarantees the two states that matter: a round with **any**
`request_changes` topic ends in `CHANGES_REQUESTED`, and a round where **every** topic passes ends in
`PASSED`. (An overall `comment` round — Medium-only, no `request_changes` — resolves to `PASSED`
because `computeReviewState` surfaces a `COMMENT` only when no substantive review exists; that is
acceptable, since the loop continues on any non-`pass` overall verdict and a `comment` topic carries
only non-blocking findings.)

```sh
# pass/comment topics first …
lh pr review <m> --repo <repo> --topic acceptance --event pass \
  --body "..." --actor reviewer-bot
# … any request_changes topic last, with its line comments
echo '[{"path":"src/a.ts","line":12,"body":"[security] ..."}]' \
  | lh pr review <m> --repo <repo> --topic security --event request_changes \
      --body "..." --comments - --actor reviewer-bot
```

- Each topic's line comments go on **that topic's** post; tag each comment body with its topic
  (`[quality]` / `[security]` / `[documentation]` / `[acceptance]`)
- Do not leave any `--body` empty
- Do not post the same `--topic` twice within one round
- Each comment element requires `path` and `body`

### A.6 Round report (parent)

Per-topic verdicts + overall verdict / finding count / line comment count / `lh pr review` result per
topic. Table for major findings (Severity | Location | Finding | Topic). Include a **review selection
line** — which roles ran/skipped and why, per [Review selection policy](#review-selection-policy) — so a
human sees the reason without re-deriving it from the diff, e.g. `Selection: quality, security skipped
(documentation-only diff); documentation, acceptance ran.` or, on a skills-only diff, `Selection: security
skipped (documentation-only diff); quality ran (touchesSkills — skills-lint exception); documentation,
acceptance ran.`

If overall `pass` or `--review-only` → full completion report. Otherwise → Phase B.

## Phase B — Fix (parent, fix phase only)

**Do not call reviewer sessions.** Parent fixes directly on head.

### B.1 Fix queue

From previous round findings, prioritize:

1. Critical / High (required)
2. Medium (if needed for `pass`)
3. Low / nit (in scope and low cost)

Escalate scope-out or design-judgment findings without fixing.

### B.2 Implement

- Edit inside the A.2 worktree (do not return to main checkout)
- Match existing naming, types, tests, style
- Fix one concern at a time; add or update related tests

### B.3 Test

Repo standard (e.g. `bun test`). When the PR touches `skills/`, also run
`bun test tests/skills-lint.test.ts`. **Green before next round.**

For UI / visual fixes, save the verification screenshot to the **persistent evidence directory**:

```text
${LOOPHUB_HOME:-$HOME/.loophub}/evidence/<owner>/<repo>/issue-<n>/
```

Key it by the **linked issue number** (`issue-<n>` — the issue the PR closes, not the `pr-<m>`
worktree name; use `pr-<m>` when there is no linked issue) so `lh-dev` and `lh-merge-ready` resolve
the same directory. Do not keep the screenshot only in the session scratchpad / `$TMPDIR` or the
worktree — both can be cleared before `lh-merge-ready` reads the directory at the end of the chain.

### B.4 Commit

```sh
git add <paths>
git commit -m "<what changed, not why>"
```

LoopHub reads local git directly; auto-sync (see [§ LoopHub](#loophub)) picks up the new
head — no manual sync needed.

Optional visibility:

```sh
lh pr comment <m> --body "Round <n>: addressed <summary>" --actor impl-bot --repo <repo>
```

### B.5 Next round

Return to Phase A (`round += 1`). Checkout usually unnecessary (already on head).

## Full completion report

- Final verdict / total rounds
- Summary of fixes per round
- Test results
- If `pass`, note `/lh-merge-ready <m>` continues (human merges)
- If `max_rounds` reached, list unresolved findings

## Called from other skills

After a PR is created, continue in the same session:

```text
/lh-pr-review <new PR number>
/lh-pr-review   # OK when the just-created PR is obvious (see PR number resolution)
```

Default: run this loop in the implementation session, not a separate session.

### After pass → merge-ready

After `pass`, **same session** pre-merge check:

```text
/lh-merge-ready <m>
```

Hand off to `lh-merge-ready`. Do not run `lh pr merge`.

## Skill chain (full)

```text
lh-issue-create → (implementation) → lh-pr-review → lh-merge-ready → (human merge)
```

## Prohibited

- Do **not** edit code during review phase (except fix phase)
- Do not delegate fixes or `lh pr review` to reviewer sessions
- Do not merge (final merge is human)
