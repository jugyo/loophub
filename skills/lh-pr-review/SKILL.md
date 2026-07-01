---
name: lh-pr-review
description: >-
  Review a LoopHub PR with quality, security, and acceptance reviewers (host-mapped subagents), fix
  findings on the head branch, and re-review until pass. Use when the user runs /lh-pr-review {pr
  id}, when asked to review a LoopHub PR, or after issue-dev creates a PR. Posts a per-topic lh pr
  review each round. Does not merge. Add --review-only for a single review without the fix loop.
---

# LoopHub PR review

Review a PR with a **quality reviewer + a security reviewer + an acceptance reviewer** (run as readonly
subagents, mapped to whatever the host provides); if findings exist, **fix on head in this session
(parent agent)** → test → **re-review** until **`pass`**. Do not merge.

Vendor-agnostic by design: the reviewer **roles** are fixed, but their **mechanism** is resolved per
host (Cursor, Claude Code, …). The Acceptance role runs only when the PR has a linked issue. See
[Reviewer roles & host mapping](#reviewer-roles--host-mapping).

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
| Quality review (bugs, correctness) | Quality reviewer subagent (host-mapped) |
| Security review | Security reviewer subagent (host-mapped) |
| Acceptance review (issue requirement / spec / AC) | Acceptance reviewer subagent (general-purpose + Acceptance prompt) |
| Issue scope alignment, test check | Parent |
| Code fixes, commits | **Parent (fix phase only)** |
| Post `lh pr review --topic <aspect>` | Parent (**once per topic per round** — see A.5) |

Reviewer subagents are **readonly** — **no fixes**, **no posts**. They are launched through the host's
subagent mechanism; the concrete `subagent_type` is chosen at runtime per
[Reviewer roles & host mapping](#reviewer-roles--host-mapping).

## Reviewer roles & host mapping

Reviews are defined by **role**, never by a vendor product name. Quality and Security run every round;
Acceptance runs every round **when the PR has a linked issue** (skipped otherwise — see A.3 / A.4):

| Role | Looks for |
|------|-----------|
| **Quality** | correctness bugs, logic errors, regressions, missed edge cases, broken contracts |
| **Security** | injection, auth/authz gaps, secret/credential exposure, unsafe input handling, supply-chain risk |
| **Acceptance** | unmet acceptance criteria, requirement/spec gaps, behavior that contradicts the linked issue |

### Capability detection (pick the best available mechanism)

At launch, map each role to the **first available** mechanism for the current host, degrading left→right.
Never hard-fail because a vendor-specific reviewer is absent — always run **every applicable** role
(Quality and Security every round; Acceptance whenever a linked issue exists) via *some* readonly subagent.

| Role | Cursor | Claude Code | Generic fallback (any host) |
|------|--------|-------------|------------------------------|
| Quality | `subagent_type: "bugbot"` | `subagent_type: "code-reviewer"` if present, else `general-purpose` | `general-purpose` subagent + Quality prompt |
| Security | `subagent_type: "security-review"` | `general-purpose` running the `/security-review` skill — fall back to a `code-review` security pass only if `/security-review` is unavailable | `general-purpose` subagent + Security prompt |
| Acceptance | `general-purpose` + Acceptance prompt | `general-purpose` + Acceptance prompt | `general-purpose` subagent + Acceptance prompt |

Acceptance is **not** a vendor product — there is no specialized reviewer for it. On every host it runs
as a `general-purpose` subagent fed the Acceptance prompt (A.3). It runs only when a linked issue exists.

Detection rule: if the named subagent type is unavailable in this host, fall to the next column. The
**prompt and expected output below are identical** regardless of which mechanism wins, so synthesis
(A.4) does not depend on the host.

**Record what actually ran.** Whichever mechanism each role resolves to, name it in the A.4 review body
(e.g. `Security: general-purpose + Security prompt — degraded`). A degraded path is allowed (review must
never hard-fail on a missing vendor reviewer), but it must be **visible** so a human can judge whether a
weaker pass was acceptable. Prefer the strongest available mechanism for the Security role —
`security-review` / `/security-review` over a generic `code-review` pass, which is correctness-focused.

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- CLI: `lh` or `bun run <repo>/src/cli.ts`
- `--repo owner/name` (omit when cwd is the repo root; **required inside `.worktrees/`**)
- `--actor reviewer-bot` (review posts) / `--actor impl-bot` (fix comments, etc.)

## Language

This skill is English. **Review output read by humans** — the `lh pr review` body (Verdict / Scope /
Reviewers / per-role sections) and every line comment — must match the **PR's language**. Code, CLI,
identifiers, and severity keywords (`pass` / `request_changes` / `comment`) stay English.

Resolve the target language once in A.1 (which already reads the PR and, when linked, the issue),
taking the first that applies: (1) the **linked issue**'s language (the primary signal); (2) the
human-authored part of the **PR body/title** (ignore tooling boilerplate); (3) the **conversation
language**; (4) **English** as the fallback when none is determinable. The reviewer subagents return
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

Each round posts one review **per topic** (quality / security / acceptance), and aggregates them into
a single **overall verdict** that drives the loop: `request_changes` if **any** topic requests changes,
otherwise `pass` only when **every** topic that ran is pass (see A.4 / A.5).

Default `max_rounds` **5**. Stop loop if the same finding persists two rounds in a row; escalate.

## Phase A — Review (each round)

Do **not** edit code during review (before or after subagent launch).

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
round number.

### A.2 Head worktree (parent)

**Do not `git checkout head.ref` on the main checkout.** Follow [Head worktree bootstrap](../README.md#head-worktree-bootstrap):

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
- Pass `--repo owner/name` on all CLI calls from inside the worktree

### A.2.5 Skills lint (parent, when PR touches `skills/`)

If `lh pr diff` includes changes under `skills/`:

```sh
bun test tests/skills-lint.test.ts
```

Any failure → **`request_changes`** (do not `pass`). Report file:line from test output.

LoopHub skills are **English-only in the body** (after YAML frontmatter). CJK in `description` is allowed
for routing triggers. Localized issue/PR templates belong in user output, not in skill files — see
`skills/README.md` § Authoring.

### A.3 Launch reviewers in parallel (parent)

Launch the **Quality**, **Security**, and **Acceptance** reviewers as **readonly subagents in one
message**; each runs once per round. Resolve each role's `subagent_type` via
[Reviewer roles & host mapping](#reviewer-roles--host-mapping) — e.g. on Cursor `bugbot` /
`security-review` / `general-purpose`, on Claude Code `code-reviewer` (or `general-purpose`) /
`general-purpose` running `/security-review` / `general-purpose`.
`description: "<Quality|Security|Acceptance> review PR #<m> round <round>"`.

**Skip Acceptance when there is no linked issue** (A.1 found no `linked_issue`): launch only Quality and
Security, and record the skip for A.4. Acceptance requires the issue's Goal + AC as input, so it cannot
run without one.

**The Quality / Security prompt is identical across hosts** — only the chosen mechanism differs:

```text
Role: <Quality | Security> reviewer (readonly — return findings only; do not edit, fix, or post)
Repository path: <worktree absolute path — cwd after A.2, not repo root>
Base branch: <base.ref from lh pr view>
Scope: review ONLY the branch diff vs base; do not flag pre-existing code outside the diff.
Custom Instructions: When the diff includes skills/**/SKILL.md, the body must be English-only (CJK only
in the YAML description for routing). Japanese issue/PR templates in skill bodies are violations. See
skills/README.md Authoring.
Return findings as a JSON array (empty [] if none):
[{ "path": "<file>", "line": <int>, "severity": "critical|high|medium|low",
   "title": "<short summary>", "body": "<problem + concrete fix>" }]
```

**The Acceptance prompt** is fed the linked issue's Goal and acceptance criteria (from A.1
`lh issue view <n>`). It checks each AC item against the diff and returns unmet items and contradictions
as findings:

```text
Role: Acceptance reviewer (readonly — return findings only; do not edit, fix, or post)
Repository path: <worktree absolute path — cwd after A.2, not repo root>
Base branch: <base.ref from lh pr view>
Linked issue #<n> goal: <issue Goal text from A.1>
Acceptance criteria (verbatim from the issue):
<paste each AC item>
Task: check the branch diff vs base against the issue's requirement, spec, and each AC item. For every
AC item that the diff does NOT satisfy, or any change that contradicts the issue's requirement/spec,
return a finding. Do not flag work that is in scope and already done; do not invent criteria beyond the
issue.
Return findings as a JSON array (empty [] if every AC item is met):
[{ "path": "<file>", "line": <int>, "severity": "critical|high|medium|low",
   "title": "<unmet AC / spec gap>", "body": "<which AC item + why the diff falls short + what is needed>" }]
```

Structured JSON output keeps A.4 merge/dedupe deterministic across hosts. If the host cannot pass a
structured diff to the subagent, substitute a natural-language change description; the JSON return shape
is unchanged.

On failure: retry once (re-resolve to the next mechanism in the mapping if the subagent type itself is
the failure).

#### Optional: false-positive filter (high-noise diffs)

When a reviewer returns many low-confidence findings, run a brief **adversarial verify** pass before
posting: spawn one readonly skeptic subagent (any available type) prompted to *refute* each
borderline finding (`{ "kept": bool, "reason": "<why>" }`). Guardrails so real signal is never lost:

- **Never delete.** Refuted findings are not dropped — move them to a **`suppressed (low-confidence)`**
  list and include that list in the A.4 synthesis output so a human can still see them.
- **Security-role and Acceptance-role findings are never suppressed** by this pass — only Quality
  findings are eligible.
- **Severity is owned by the original reviewer.** The skeptic may mark `kept:false`, but may not lower a
  finding's severity. All Critical/High stay in the active set regardless of the skeptic.

Skip this pass entirely when findings are few or clearly real.

### A.4 Synthesize per topic (parent)

Reviews are posted **per topic** (#209: `lh pr review --topic <aspect>`). Keep each role's findings in
its **own** topic bucket — `quality`, `security`, `acceptance` — instead of merging them into one body.

1. **Scope** (round-wide): Does PR match the issue goal? One or two sentences reused in each topic body.
2. **Per-topic findings**: keep Quality / Security / Acceptance findings separate, each by severity. The
   Quality-only false-positive filter (A.3) applies to the `quality` bucket only. Acceptance has **no**
   bucket when A.3 skipped it (no linked issue) — that topic is simply not posted in A.5.
3. **Per-topic verdict** — decide each topic on its **own** findings:

   | Topic | `request_changes` when | `pass` when |
   |-------|------------------------|----------------|
   | `quality` | unresolved Critical / High, **or** skills lint failed (A.2.5) | no Critical/High and lint passed (Medium-only → `comment`) |
   | `security` | unresolved Critical / High | none unresolved |
   | `acceptance` | any unmet AC item or behavior contradicting the issue's spec | every AC item met |

   Skills lint failure (A.2.5) belongs to the **quality** topic — it forces `quality` to
   `request_changes`.
4. **Overall verdict** (round-wide, drives the loop): `request_changes` if **any** topic is
   `request_changes`; else `comment` if any topic is `comment`; else `pass` (every topic that ran is
   pass). Only `pass` exits the loop.

Per-topic `--body` template (one per topic; include round number and the same Scope line):

```markdown
## <Quality|Security|Acceptance> — Verdict: <pass|request_changes|comment>
Round: <n>/<max_rounds>
Reviewer: <mechanism this role actually ran — note "degraded" if a fallback was used>

### Scope
<shared 1–2 sentences on issue alignment>

### Findings
<this topic's finding count + summary, or "none">
<quality only: note any suppressed low-confidence items>
<acceptance only: per-AC pass/fail against the issue>

### Tests
<commands run and results; the quality body includes skills-lint when skills/ changed>
```

### A.5 Post per topic (parent, required each round)

Post **one review per topic** that ran (`quality`, `security`, and `acceptance` unless A.3 skipped it),
each tagged with `--topic` and carrying that topic's own verdict, body, and line comments. **Once per
topic per round** — never post the same topic twice in one round (the per-round double-post guard now
applies per topic; multiple rounds across the loop are still fine).

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
  (`[quality]` / `[security]` / `[acceptance]`)
- Do not leave any `--body` empty
- Do not post the same `--topic` twice within one round
- Each comment element requires `path` and `body`

### A.6 Round report (parent)

Per-topic verdicts + overall verdict / finding count / line comment count / `lh pr review` result per
topic. Table for major findings (Severity | Location | Finding | Topic).

If overall `pass` or `--review-only` → full completion report. Otherwise → Phase B.

## Phase B — Fix (parent, fix phase only)

**Do not call subagents.** Parent fixes directly on head.

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

For UI / visual fixes, save the verification screenshot to the **persistent evidence directory**
(`${LOOPHUB_HOME:-$HOME/.loophub}/evidence/<owner>/<repo>/issue-<n>/`; see `skills/README.md` §
Evidence screenshots), not only the session scratchpad / `$TMPDIR` or worktree — so it is still
present when `lh-merge-ready` reads the directory at the end of the chain.

### B.4 Commit

```sh
git add <paths>
git commit -m "<what changed, not why>"
```

LoopHub reads local git directly; lh-web sweeps open-PR head SHAs and auto-fires
`pull_request.updated`, so no manual sync is needed.

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

See `skills/lh-merge-ready/SKILL.md`. Do not run `lh pr merge`.

## Skill chain (full)

```text
lh-issue-create → (implementation) → lh-pr-review → lh-merge-ready → (human merge)
```

## Prohibited

- Do **not** edit code during review phase (except fix phase)
- Do not delegate fixes or `lh pr review` to subagents
- Do not merge (final merge is human)
