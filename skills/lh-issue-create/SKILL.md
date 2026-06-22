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
| Gather context, check duplicates, `lh issue create`, report creation | Edit source, create branches, add tests, open PRs, merge |
| Read-only code exploration (to refine AC) | Start implementation |
| **Suggest** the next skill in text | **Continue** to the next skill yourself |

The `ready-to-build` label means "another agent can pick this up later" — not "implement now".

### Done when

Stop **immediately** when all of the following are true (do not start extra work):

- [ ] `lh issue create` succeeded
- [ ] Issue number, title, and labels reported to the user
- [ ] The user has **not** separately asked to "implement" or "continue"

### Common mistakes

```text
❌ After creating an issue, "while I'm here" cut a branch and start coding
❌ Read code to write AC, then fix problems found on the spot
❌ Auto-start grab / issue-dev because you see the skill chain
✅ Create issue → report number → stop (implementation needs explicit user or separate skill)
```

## Invocation

`/lh-issue-create` — file an issue from conversation context. Follow any title or type the user
specifies.

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

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

- **baseUrl**: `url` in `~/.loophub/config.json` → `http://localhost:${LOOPHUB_PORT:-8730}` (`LOOPHUB_URL`
  is the CLI API target, not the user-facing UI link)
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

For **AFK implementation**, add the `ready-to-build` label (omit if waiting on human review).

CLI:

```sh
lh issue create --repo <repo> --title "<title>" \
  --body "$(cat <<'EOF'
<filled template>
EOF
)" --label ready-to-build,bug --actor triage-bot
```

Add category label `bug` / `enhancement` as appropriate.

### 5. Report (stop here)

After creation:

1. Report issue number, title, and labels
2. Show the **issue URL** (Web URL format above) as a markdown link
3. **Stop** — skill work is complete at this point
4. Do **not** start implementation unless the user asked for it. Optional guidance only:

```text
To implement: start implementation on issue <n> (a separate request)
```

## Follow-on work (user must ask explicitly)

```text
lh-issue-create → [stop] → (separate request) implementation → lh-pr-review → ...
```

Do **not** auto-chain to implementation. Only start implementing if the user asked to both
create and implement in the same message.

## Prohibited

- Do not implement, open PRs, or merge inside this skill
- Do not branch, edit source, or run tests (for fixes) after creating an issue
- Do not skip duplicate check
- Do not start implementation without user consent
