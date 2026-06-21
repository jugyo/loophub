---
name: loophub-pr-review
description: >-
  Review a LoopHub PR with quality and security reviewers (host-mapped subagents), fix findings
  on the head branch, and re-review until approve. Use when the user runs /loophub-pr-review {pr
  id}, when asked to review a LoopHub PR, or after issue-dev creates a PR. Posts lh pr review each
  round. Does not merge. Add --review-only for a single review without the fix loop.
---

# LoopHub PR review

Review a PR with a **quality reviewer + a security reviewer** (run as readonly subagents, mapped to
whatever the host provides); if findings exist, **fix on head in this session (parent agent)** → test →
**re-review** until **`approve`**. Do not merge.

Vendor-agnostic by design: the two reviewer **roles** are fixed, but their **mechanism** is resolved per
host (Cursor, Claude Code, …). See [Reviewer roles & host mapping](#reviewer-roles--host-mapping).

Distinct from Cursor's built-in `/loop` (scheduled wake). Here, "loop" means **review → fix → review**.

## Invocation

```text
/loophub-pr-review <pr id>              # loop enabled (default)
/loophub-pr-review <pr id> --review-only   # single review (no fix loop)
/loophub-pr-review <pr id> --max-rounds 8  # max rounds (default 5)
/loophub-pr-review                      # resolve PR from session context (see below)
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
| PR already loaded in this session | `lh pr view <m>` or `/loophub-pr-review <m>` earlier in chat |
| User named the PR in the immediately preceding message | "review this" right after posting PR #42 URL |
| Linked issue maps to exactly one open PR | `lh issue view <n>` → `linked_pull_request`, or single open PR with `--issue <n>` |

If multiple signals agree on the same `<m>`, use it. If they disagree, treat as **not obvious**.

#### Not obvious (ask the user)

- Two or more open PRs and no single signal above
- No PR created yet in this session (issue-dev stopped before PR, etc.)
- Conversation switched to a different PR or issue since the last clear target
- Signals point to different PR numbers

```text
Which PR should I review? (e.g. /loophub-pr-review 42)
```

## Role split

| Role | Owner |
|------|-------|
| Loop control, fixes | **Parent (this session)** |
| LoopHub context | Parent |
| Checkout head branch | Parent |
| Quality review (bugs, correctness) | Quality reviewer subagent (host-mapped) |
| Security review | Security reviewer subagent (host-mapped) |
| Issue scope alignment, test check | Parent |
| Code fixes, commits | **Parent (fix phase only)** |
| Post `lh pr review` | Parent (**once per review round**) |

Reviewer subagents are **readonly** — **no fixes**, **no posts**. They are launched through the host's
subagent mechanism; the concrete `subagent_type` is chosen at runtime per
[Reviewer roles & host mapping](#reviewer-roles--host-mapping).

## Reviewer roles & host mapping

Reviews are defined by **role**, never by a vendor product name. Two roles run every round:

| Role | Looks for |
|------|-----------|
| **Quality** | correctness bugs, logic errors, regressions, missed edge cases, broken contracts |
| **Security** | injection, auth/authz gaps, secret/credential exposure, unsafe input handling, supply-chain risk |

### Capability detection (pick the best available mechanism)

At launch, map each role to the **first available** mechanism for the current host, degrading left→right.
Never hard-fail because a vendor-specific reviewer is absent — always run **both** roles via *some*
readonly subagent.

| Role | Cursor | Claude Code | Generic fallback (any host) |
|------|--------|-------------|------------------------------|
| Quality | `subagent_type: "bugbot"` | `subagent_type: "code-reviewer"` if present, else `general-purpose` | `general-purpose` subagent + Quality prompt |
| Security | `subagent_type: "security-review"` | `general-purpose` running the `/security-review` skill — fall back to a `code-review` security pass only if `/security-review` is unavailable | `general-purpose` subagent + Security prompt |

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

## Full loop

```text
round = 1
while round <= max_rounds:
  A. Review (steps 1–6) → verdict
  if verdict == approve:
    report completion and exit
  if --review-only:
    report and exit (no fixes)
  B. Fix (step 7) — parent on head
  if unfixable blocker:
    report and exit
  round += 1
report: max_rounds reached; escalate to human
```

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

Any failure → **`request_changes`** (do not `approve`). Report file:line from test output.

LoopHub skills are **English-only in the body** (after YAML frontmatter). CJK in `description` is allowed
for routing triggers. Localized issue/PR templates belong in user output, not in skill files — see
`skills/README.md` § Authoring.

### A.3 Launch reviewers in parallel (parent)

Launch the **Quality** and **Security** reviewers as **readonly subagents in one message**; each runs
once per round. Resolve each role's `subagent_type` via
[Reviewer roles & host mapping](#reviewer-roles--host-mapping) — e.g. on Cursor `bugbot` /
`security-review`, on Claude Code `code-reviewer` (or `general-purpose`) / `general-purpose` running
`/security-review`. `description: "<Quality|Security> review PR #<m> round <round>"`.

**The prompt is identical across hosts** — only the chosen mechanism differs:

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
- **Security-role findings are never suppressed** by this pass — only Quality findings are eligible.
- **Severity is owned by the original reviewer.** The skeptic may mark `kept:false`, but may not lower a
  finding's severity. All Critical/High stay in the active set regardless of the skeptic.

Skip this pass entirely when findings are few or clearly real.

### A.4 Synthesize (parent)

1. **Scope**: Does PR match issue goal?
2. **Merge findings**: Quality + Security by severity
3. **Dedupe**: Same file:line → one line comment tagged with its role source: `[Quality]` / `[Security]`
4. **Verdict**:
   - Unresolved Critical / High → `request_changes`
   - Skills lint failed (A.2.5) → `request_changes`
   - Medium only → `comment` or `approve` (if scope and tests OK)
   - No findings + scope OK + tests sufficient → `approve`

`--body` template (include round number):

```markdown
## Verdict: <approve|request_changes|comment>
Round: <n>/<max_rounds>

### Scope
<1–2 sentences on issue alignment>

### Reviewers
<mechanism each role actually ran, e.g. Quality: general-purpose · Security: /security-review — note "degraded" if a fallback was used>

### Quality
<finding count or none; note any suppressed low-confidence items>

### Security
<finding count or none>

### Tests
<commands run and results; include skills-lint when skills/ changed>
```

### A.5 Post (parent, required each round)

Post **once per round** as that round's review (multiple rounds OK across the loop).

```sh
lh pr review <m> --repo <repo> --event approve|request_changes|comment \
  --body "..." --actor reviewer-bot
```

Line comments:

```sh
echo '[{"path":"src/a.ts","line":12,"body":"[Quality] ..."}]' \
  | lh pr review <m> --repo <repo> --event request_changes \
      --body "..." --comments - --actor reviewer-bot
```

- Do not leave `--body` empty
- Do not double-post within the same round
- Each comment element requires `path` and `body`

### A.6 Round report (parent)

Verdict / finding count / line comment count / `lh pr review` result. Table for major findings
(Severity | Location | Finding | Source).

If `approve` or `--review-only` → full completion report. Otherwise → Phase B.

## Phase B — Fix (parent, fix phase only)

**Do not call subagents.** Parent fixes directly on head.

### B.1 Fix queue

From previous round findings, prioritize:

1. Critical / High (required)
2. Medium (if needed for `approve`)
3. Low / nit (in scope and low cost)

Escalate scope-out or design-judgment findings without fixing.

### B.2 Implement

- Edit inside the A.2 worktree (do not return to main checkout)
- Match existing naming, types, tests, style
- Fix one concern at a time; add or update related tests

### B.3 Test

Repo standard (e.g. `bun test`). When the PR touches `skills/`, also run
`bun test tests/skills-lint.test.ts`. **Green before next round.**

### B.4 Commit and sync

```sh
git add <paths>
git commit -m "<what changed, not why>"
lh sync   # when LoopHub reads local git
```

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
- If `approve`, note `/loophub-merge-ready <m>` continues (human merges)
- If `max_rounds` reached, list unresolved findings

## Called from other skills

After a PR is created, continue in the same session:

```text
/loophub-pr-review <new PR number>
/loophub-pr-review   # OK when the just-created PR is obvious (see PR number resolution)
```

Default: run this loop in the implementation session, not a separate session.

### After approve → merge-ready

After `approve`, **same session** pre-merge check:

```text
/loophub-merge-ready <m>
```

See `skills/loophub-merge-ready/SKILL.md`. Do not run `lh pr merge`.

## Skill chain (full)

```text
loophub-issue-create → (implementation) → loophub-pr-review → loophub-merge-ready → (human merge)
```

## Prohibited

- Do **not** edit code during review phase (except fix phase)
- Do not delegate fixes or `lh pr review` to subagents
- Do not merge (final merge is human)
