---
name: lh-issue-create
description: >-
  Create an AFK-ready LoopHub issue from conversation or a bug report, then STOP. Never
  implements, branches, edits code, or opens PRs unless the user explicitly asks in a separate
  message. Use when the user runs /lh-issue-create, asks to create/file/open an issue only,
  起票, issue作成, or turn chat into an issue — NOT when they ask to implement or fix.
---

# LoopHub issue create

Create an **AFK-agent-ready issue** in LoopHub from conversation, bug reports, or notes. **Stop after
reporting creation. Do not implement or merge.**

## Scope boundary (read first)

**This skill ends when the issue is created.** If the user only asked to "create an issue" or "file a
ticket", that does **not** include an implementation request.

| Do | Do not |
|----|--------|
| Gather context, check duplicates, `lh issue create`, report creation | **Carry out the requested change itself — whatever kind** (source, skill, config, doc, policy, …); create branches; add tests; open PRs; merge |
| Read-only code exploration (to refine AC) | Start implementation |
| **Suggest** the next skill in text | **Continue** to the next skill yourself |

The `ready-to-build` label means "another agent can pick this up later" — not "implement now".

**Exception — herdr mode only (see § 5).** In herdr mode this skill asks once, after reporting
creation, whether to start now. Only an explicit "yes" launches anything, and even then this
skill session itself still never implements — it starts a **new** herdr tab/agent to run
`lh dev`, the same way the Web UI's Build button does. That is "suggest, then act on consent",
not "continue to the next skill yourself".

**The output of this skill is always an issue — never the change itself, whatever the request is.**
"Do not" covers *executing the requested change inside this skill* — not just writing source code.
This holds **regardless of how the request reads**: the kind of change does not narrow the rule. If a
request reads like implementation, the deliverable is still an issue that *describes* the change —
then stop.

The categories below are **non-exhaustive examples**, not the boundary — any other kind of change is
treated the same way:

- **Source code** — "fix this bug", "add this validation". File it; do **not** edit code.
- **Operational / policy changes** — "let's stop using labels", "don't attach `ready-to-build` by
  default". File it; do **not** apply the policy.
- **Skill / config / doc edits** — "fix this skill so it…", "if any skill expects this, fix it too".
  File it; do **not** edit the skill, config, or doc.

If you cannot place a request into one of these buckets, that does **not** make it in scope to
execute — when in doubt, file an issue describing the change and stop. (The only exception is when the
user explicitly asked to both create the issue **and** implement in the same message; see
§ Follow-on work.)

### Done when

Stop **immediately** when all of the following are true (do not start extra work):

- [ ] `lh issue create` succeeded
- [ ] Issue number, title, and labels (if any) reported to the user
- [ ] The user has **not** separately asked to "implement" or "continue" — in herdr mode, this
      also covers the case where you asked (§5) and the user declined or didn't answer

### Common mistakes

```text
❌ After creating an issue, "while I'm here" cut a branch and start coding
❌ Read code to write AC, then fix problems found on the spot
❌ Auto-start grab / issue-dev because you see the skill chain
❌ "Let's stop using labels" / "fix this skill so it…" → edit the policy or skill file directly
❌ Treat any request that "reads like implementation" as a license to apply the change here
❌ Ask "start now?" in builtin mode (`HERDR_ENV` not `1`) — that question is herdr-only
❌ In herdr mode, skip asking and launch `lh dev` anyway, or implement inside this session instead
   of a new herdr tab/agent
✅ Create issue → report number → stop (implementation needs explicit user or separate skill)
✅ herdr mode: ask once whether to start now → only on "yes", launch a new herdr tab/agent
✅ Any change request (code, policy, skill, config, doc, …) → file an issue describing it → stop
```

## Invocation

`/lh-issue-create` — file an issue from conversation context. Follow any title or type the user
specifies.

### Question mode (no arguments, no context)

If the skill is invoked **without arguments and without any conversation context to draw an issue
from** (e.g. a fresh session where the user only typed `/lh-issue-create`, with no preceding bug
report, request, or notes), do **not** guess or fabricate an issue. Enter **question mode**.

**First, ask exactly one open question and stop there.** Use this fixed opener — render it in the
conversation language as its plain equivalent, adding nothing:

> What's going on?

Keep it to that wording. Do **not** rephrase it into a filing-oriented prompt (no "What do you want to
file?", no "What do you want to report?"), do **not** prepend or append any word-count or brevity
qualifier ("briefly", "in one word", "in a sentence", "in a few words", etc.), do **not** front-load
the full list of required fields, and do **not** open by asking which category it is (no "bug or
enhancement?"). The opener is a bare, neutral "what's wrong / how can I help" — not a request to
summarize and not a request to declare what to file. Infer `bug` / `enhancement` and the rest
yourself from the reply rather than interrogating up front.

**Then, after the user replies, fill in the rest progressively** — ask only for the fields still
missing, and only as needed:

- **Title candidate** (one line, starts with a verb)
- **Category** (`bug` / `enhancement`) — infer from the reply; ask only if genuinely ambiguous
- **Goal** (what "done" looks like)
- **Acceptance criteria** (verifiable bullets)
- **Target repository** — `--repo owner/name` (only when cwd doesn't already resolve it; see § LoopHub)

The user's first reply often already supplies several of these (or lets you infer them) — derive what
you can and ask only for the genuinely missing pieces, one small follow-up at a time rather than a
single bulk interrogation. Once you have enough to file, proceed with the normal flow (§ Procedure).

When the recent conversation **does** contain material to file from (a bug report, a request, notes),
this is the normal case — proceed straight from that context (§ Procedure step 1) and do **not** enter
question mode; ask only for whatever specific detail is missing (as step 1 already says).

Question mode does **not** change the scope boundary: it only collects what to file. After the issue
is created, **stop** — do not implement (see § Scope boundary).

## LoopHub

- **Server**: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh` (on PATH)
- **`--repo owner/name`**: omit only when cwd is the repo root; required inside a worktree
- `--actor triage-bot` (default) or user-specified

| Action | CLI |
|--------|-----|
| Duplicate check | `lh issue list` or `lh issue view` |
| Create issue | `lh issue create` |
| Verify after create | `lh issue view <n>` |

### Web URL (for reporting)

Always show the user a UI URL when reporting creation (no CLI output changes required).

```text
{baseUrl}/r/{owner}/{repo}/issues/{n}
```

- **baseUrl**: `lh info --json | jq -r .baseUrl` (do **not** read `~/.loophub/config.json` directly —
  `lh info` applies the canonical resolution order: `LOOPHUB_URL` → config `url` →
  `http://localhost:${LOOPHUB_PORT:-8730}`)
- **owner/repo**: `--repo` at create time when cwd doesn't already resolve it, or repo resolution
  from cwd (same as `lh issue view` / `resolveRepo()`)

Example: `http://localhost:8730/r/jugyo/local-github/issues/42`

## Language

**Issue output** (title, body headings, prose, checklist items) must match the
user's **conversation language** — translate section headings and text; do not paste the English
template below verbatim when the user writes in another language. Code, CLI, and commit messages stay
English.

## Procedure

### 1. Gather context

Extract from the conversation:

- **Title candidate** (one line, start with a verb)
- **Category**: `bug` / `enhancement`
- **Goal** (what "done" looks like)
- **Acceptance criteria** (verifiable bullets)
- **Out of scope** (what not to do)
- **Blocked by** (dependent issues, if any)

Ask the user briefly if anything is missing.

#### Coverage check (only when the target may appear in multiple places)

Some issues name a **UI element or shared concept** — "list item", "badge", "the <element> row", a
status indicator — that *looks* like one thing but is rendered in several places. These are the
**ambiguity-prone signals**: a shared UI noun, or any "<element> row / item / badge" that could have
more than one renderer. When you spot one, run a **single** targeted confirmation before filing:

> Does this target appear in more than one place? If so, is **every** place in scope, or just one
> specific screen?

This is **conditional — not a new default question.** Ask it only when a coverage-ambiguous signal is
present; when the target is unambiguously a single place, skip it. The AFK premise depends on not
overloading the user with questions, so the goal is one well-aimed question on the risky cases, not
more questions everywhere.

When the answer is "every place is in scope", fold the coverage into the issue so it can't silently
collapse to a single site:

- List the actual occurrence sites in **Goal** (or state "all of them"), and
- Add **one AC line that verifies coverage**, e.g.
  `- [ ] <element> is shown in **all** places it renders (A / B / C)` — so a single-site implementation
  cannot tick every box.

> **Why this step exists (#194 → #226).** #194 asked to "show PR info on the issue list item". The
> "issue list item" is actually rendered in 3 places (home `IssueRow` / repo dashboard `IssueRow` /
> dedicated `IssueListRow`), but the issue listed none of them, and an Out-of-scope line ("screens
> other than the issue list item") was read as excluding two of the three intended sites. Only 1 of 3
> was implemented and a follow-up issue (#226) was needed to finish the rest. A coverage question plus
> a "shown in all places" AC would have caught it up front.

### 2. Duplicate check

Search existing issues before creating:

```sh
lh issue list --repo <repo>
```

If a similar issue exists, show its number and the delta; let the user choose create new / comment on
existing / abort.

### 3. Body template

```markdown
## Goal

<1–3 sentences describing done>

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Out of scope

- <what not to do; or "None">

## Blocked by

None — can start immediately

<!-- or: #12, #34 -->
```

**Out of scope — re-read for over-exclusion.** Before finalizing, check each exclusion line once:
could it be read to **also exclude a place you actually want in scope**? An exclusion like "screens
other than <element>" easily reads as ruling out sites you intended to cover (this is what happened in
#194 — see the Coverage check in step 1). Prefer naming what is excluded positively, and list the
in-scope sites explicitly in Goal/AC so an exclusion line can't swallow them.

### 4. Create

**Do not attach labels by default.** Mechanical per-issue labels — category (`enhancement` /
`bug`) and `ready-to-build` — have little practical value, so this skill no longer adds them
automatically. Attach a label only when it forms a **meaningful grouping** — and, except for
related multi-issue creation (the exception below), only when the user explicitly asks for it:

- **Category** (`enhancement` / `bug`): omit by default. Add only if the user explicitly asks
  to categorize.
- **`ready-to-build`**: omit by default. It flags "an AFK agent may pick this up"; the human
  sets it by clicking **Build** in the Web UI (shown until a PR is in progress or merged — it
  reappears if the linked PR was closed unmerged), or you pass `--label ready-to-build` **only**
  when the user explicitly asks to mark it ready.
- **Theme / grouping label** (e.g. `ui-v3`): add only when the user names a theme to group a
  set of issues under — **except** for related multi-issue creation, which is the one case
  where a grouping label is required even without an explicit request (see below).

**Exception — related multi-issue creation always gets a grouping label.** When a single request
is split into **multiple related issues** in one filing (e.g. #253 / #254 / #255 splitting one
requirement), attach a **common grouping label to every issue in the set** — even when the user
did **not** explicitly name a theme. This is the one case where a grouping label is added without
an explicit request, so the related issues can be traced together later. It does **not** change
the single-issue default: filing **one** issue on its own stays label-free unless the user asks.

- **Naming**: derive the label from the shared theme of the request, in **kebab-case** (e.g.
  `pr-status-color`, `issue-list-coverage`). Keep it short and specific to the group. Reuse a
  theme label the user already named instead of inventing a second one.
- **Applying**: pass the **same** `--label <name>` on **every** `lh issue create` in the group
  (see CLI below). Mention the chosen grouping label when you report creation (step 5).

CLI (no labels — the default for a single, standalone issue):

```sh
lh issue create --repo <repo> --title "<title>" \
  --body "$(cat <<'EOF'
<filled template>
EOF
)" --actor triage-bot
```

Append `--label <name>` for an explicitly requested grouping/theme, for `ready-to-build`, or — on
**related multi-issue creation** — for the required common grouping label applied to every issue in
the set (above). For a single standalone issue with no explicit request, omit it.

### 5. Report (stop here — except herdr mode, below)

After creation:

1. Report issue number, title, and labels (usually none — see step 4)
2. Show the **issue URL** (Web URL format above) as a markdown link
3. **Stop** — skill work is complete at this point, unless herdr mode applies below

**Builtin mode (default).** When `HERDR_ENV` is unset or not `1`, do **not** start implementation
on your own and do **not** ask. The user runs `lh dev <issue-id>` themselves in a shell to begin
implementation; no prompting from this skill is needed. (Only implement in-skill if the user
explicitly asked to both create and implement in the same message.)

For unattended (AFK) runs, recommend `--sandbox` — only then does `lh dev` enable auto mode
(`acceptEdits`); without it the session uses Claude's normal approval mode:

```sh
lh dev --sandbox <issue-id>
```

**herdr mode.** When `HERDR_ENV=1` — the same detection the `herdr` skill uses (`echo $HERDR_ENV`)
— ask once, right after reporting creation, whether to start now. This is the Build button's
question, asked proactively instead of waiting for the user to click it:

> Start working on this now? (opens a new herdr tab running `lh dev`)

- **Declines, or doesn't answer**: stop exactly as in builtin mode above — issue only, no
  implementation, no further prompting.
- **Agrees**: launch the same flow the Web UI's **Build** button triggers — a new herdr tab +
  agent running `lh dev '<repo>/<n>'`. There is no CLI/RPC entry point for that reachable from a
  skill session, so drive the `herdr` CLI directly instead. `herdr agent start` is a documented
  subcommand of the `herdr` binary itself (`herdr agent --help`), used here the same session-less
  way as the `herdr tab create` call below — both target the currently running instance from
  inside a herdr pane, unlike a server-side launcher (outside herdr, so it must name a `--session`
  explicitly):

  ```sh
  AUTO=$(jq -r '.autoModeOnBuild // false' "${LOOPHUB_HOME:-$HOME/.loophub}/config.json" 2>/dev/null)
  TARGET=$(printf '%q' "<repo>/<n>")   # safe against shell metacharacters before the zsh -lc re-parse below
  CMD="lh dev $TARGET"; [ "$AUTO" = "true" ] && CMD="$CMD --auto"
  CREATE=$(herdr tab create --cwd "$(pwd)" --no-focus)
  TAB_ID=$(echo "$CREATE" | jq -r '.result.tab.tab_id')
  ROOT_PANE_ID=$(echo "$CREATE" | jq -r '.result.root_pane.pane_id')
  herdr agent start "lh dev #<n>" --cwd "$(pwd)" --tab "$TAB_ID" --no-focus -- zsh -lc "$CMD" \
    && herdr pane close "$ROOT_PANE_ID"   # only drop the seeded empty pane once the agent's own pane exists
  ```

  Assumes this skill is running from the repo's checkout root, not a worktree — true for
  `lh-issue-create` (worktrees only exist for issue-dev sessions). If the `herdr` calls fail
  (unexpected outside a real herdr pane, or a transient CLI error), report the failure and fall
  back to the builtin-mode guidance above (`lh dev <issue-id>` for the user to run themselves)
  rather than leaving the user stuck.

## Follow-on work

```text
lh-issue-create → [stop] → user runs `lh dev --sandbox <issue-id>` in a shell → lh-pr-review → ...
```

**Builtin mode.** Do **not** auto-chain to implementation. After creating the issue, the user
starts implementation themselves by running `lh dev <issue-id>` in a shell. Only implement inside
this skill if the user explicitly asked to both create and implement in the same message.

**herdr mode.** After creation, ask once (§5); on explicit consent, chain by launching a **new**
herdr tab/agent running `lh dev` — not by implementing inside this session. On decline or silence,
same as builtin mode.

## Prohibited

- Do not implement, open PRs, or merge inside this skill
- Do not branch, edit source, or run tests (for fixes) after creating an issue
- Do not carry out the requested change yourself — whatever kind it is (code, policy, skill, config,
  doc, …) — even when the request reads like implementation; file an issue describing it instead
- Do not skip duplicate check
- Do not start implementation without user consent — in herdr mode, ask (§5); never assume "yes"
- Do not ask "start now?" outside herdr mode (`HERDR_ENV` not `1`)
