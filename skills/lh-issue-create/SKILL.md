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
§ Follow-on work (user-driven).)

### Done when

Stop **immediately** when all of the following are true (do not start extra work):

- [ ] `lh issue create` succeeded
- [ ] Issue number, title, and labels (if any) reported to the user
- [ ] The user has **not** separately asked to "implement" or "continue"

### Common mistakes

```text
❌ After creating an issue, "while I'm here" cut a branch and start coding
❌ Read code to write AC, then fix problems found on the spot
❌ Auto-start grab / issue-dev because you see the skill chain
❌ "Let's stop using labels" / "fix this skill so it…" → edit the policy or skill file directly
❌ Treat any request that "reads like implementation" as a license to apply the change here
✅ Create issue → report number → stop (implementation needs explicit user or separate skill)
✅ Any change request (code, policy, skill, config, doc, …) → file an issue describing it → stop
```

## Invocation

`/lh-issue-create` — file an issue from conversation context. Follow any title or type the user
specifies.

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

### Question mode (no arguments, no context)

If the skill is invoked **without arguments and without any conversation context to draw an issue
from** (e.g. a fresh session where the user only typed `/lh-issue-create`, with no preceding bug
report, request, or notes), do **not** guess or fabricate an issue. Enter **question mode**: ask the
user — in plain text is enough — for the minimum information needed to file, then proceed with the
normal flow (§ Procedure) once you have it. At minimum, ask for:

- **Title candidate** (one line, starts with a verb)
- **Category** (`bug` / `enhancement`)
- **Goal** (what "done" looks like)
- **Acceptance criteria** (verifiable bullets)
- **Target repository** — `--repo owner/name` (only when cwd doesn't already resolve it; see § LoopHub)

When the recent conversation **does** contain material to file from (a bug report, a request, notes),
this is the normal case — proceed straight from that context (§ Procedure step 1) and do **not** enter
question mode; ask only for whatever specific detail is missing (as step 1 already says).

Question mode does **not** change the scope boundary: it only collects what to file. After the issue
is created, **stop** — do not implement (see § Scope boundary).

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh` or `bun run <repo>/src/cli.ts` — create, duplicate check, verify
- `--repo owner/name` (omit when cwd is the repo root; **required inside `.worktrees/`**)
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
  `lh info` applies the canonical resolution order: `LOOPHUB_URL` → config `url` → `http://localhost:${LOOPHUB_PORT:-8730}`)
- **owner/repo**: `--repo` at create time (when omitted, same resolution as `resolveRepo()` from cwd)

Example: `http://localhost:8730/r/jugyo/local-github/issues/42`

## Language

This skill is English. **Issue output** (title, body headings, prose, checklist items) must match the
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

### 4. Create

**Do not attach labels by default.** Mechanical per-issue labels — category (`enhancement` /
`bug`) and `ready-to-build` — have little practical value, so this skill no longer adds them
automatically. Attach a label only when it forms a **meaningful grouping** and the user
explicitly asks for it:

- **Category** (`enhancement` / `bug`): omit by default. Add only if the user explicitly asks
  to categorize.
- **`ready-to-build`**: omit by default. It flags "an AFK agent may pick this up"; the human
  sets it by clicking **Build** in the Web UI (shown until a PR is in progress or merged — it
  reappears if the linked PR was closed unmerged), or you pass `--label ready-to-build` **only**
  when the user explicitly asks to mark it ready.
- **Theme / grouping label** (e.g. `ui-v3`): add only when the user names a theme to group a
  set of issues under.

CLI (no labels — the default):

```sh
lh issue create --repo <repo> --title "<title>" \
  --body "$(cat <<'EOF'
<filled template>
EOF
)" --actor triage-bot
```

Append `--label <name>` only for an explicitly requested grouping/theme or `ready-to-build`.

### 5. Report (stop here)

After creation:

1. Report issue number, title, and labels (usually none — see step 4)
2. Show the **issue URL** (Web URL format above) as a markdown link
3. **Stop** — skill work is complete at this point
4. Do **not** start implementation on your own. The user runs `lh dev <issue-id>` themselves
   in a shell to begin implementation; no prompting from this skill is needed. (Only implement
   in-skill if the user explicitly asked to both create and implement in the same message.)

   For unattended (AFK) runs, recommend `--sandbox` — only then does `lh dev` enable auto mode
   (`acceptEdits`); without it the session uses Claude's normal approval mode:

   ```sh
   lh dev --sandbox <issue-id>
   ```

## Follow-on work (user-driven)

```text
lh-issue-create → [stop] → user runs `lh dev --sandbox <issue-id>` in a shell → lh-pr-review → ...
```

Do **not** auto-chain to implementation. After creating the issue, the user starts
implementation themselves by running `lh dev <issue-id>` in a shell. Only implement inside
this skill if the user explicitly asked to both create and implement in the same message.

## Prohibited

- Do not implement, open PRs, or merge inside this skill
- Do not branch, edit source, or run tests (for fixes) after creating an issue
- Do not carry out the requested change yourself — whatever kind it is (code, policy, skill, config,
  doc, …) — even when the request reads like implementation; file an issue describing it instead
- Do not skip duplicate check
- Do not start implementation without user consent
