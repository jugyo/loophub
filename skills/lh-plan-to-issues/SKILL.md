---
name: lh-plan-to-issues
description: >-
  Break a plan, SPEC, or PRD into vertical-slice LoopHub issues, then STOP. Never implements,
  branches, edits code, or opens PRs unless the user explicitly asks separately. Use when the
  user runs /lh-plan-to-issues, wants to convert a plan into tickets or 起票/issue作成 only
  — NOT when they ask to implement or fix.
---

# LoopHub plan to issues

Break a plan, SPEC, PRD, or design conversation into **vertical-slice** issues and publish them to
LoopHub. **Stop after publish report. Do not implement or merge.**

## Scope boundary (read first)

**This skill ends when issues are published.** If the user only asked to "break the plan into issues",
that does **not** include implementation.

| Do | Do not |
|----|--------|
| Slice decomposition, user confirmation, `lh issue create`, list report | Edit source, branches, tests, PRs, merge |
| Read-only code exploration (terminology, ADR alignment) | Start implementation |
| **Suggest** start order | **Auto-start** the first slice |

### Done when

- [ ] All approved slices published
- [ ] Reported list with number, title, Type, Blocked by
- [ ] User has **not** separately asked to "implement" → **stop immediately**

LoopHub variant of the generic `to-issues` skill.

## Invocation

`/lh-plan-to-issues` — use conversation context or an issue / document from arguments.

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh issue create|view|list` — publish and verify
- `--repo owner/name` (omit when cwd is the repo root; **required inside `.worktrees/`**)
- `--actor triage-bot` (default)

## Language

This skill is English. **Issue output** (slice titles, body headings, prose) must match the user's
**conversation language** — translate section headings and text; do not paste the English template
below verbatim when the user writes in another language. Code and CLI stay English.

## Procedure

### 1. Gather context

Use the plan from conversation if present. If an issue number or path is given:

```sh
lh issue view <n> --repo <repo>
```

Explore the codebase as needed; align domain terms with existing ADR / SPEC.

### 2. Decompose into vertical slices

**Tracer bullet** rules (vertical, not horizontal):

- Each slice cuts through all layers — schema → API → UI → tests — as a thin vertical strip
- Each completed slice is demoable / verifiable on its own
- Prefer many thin issues over few thick ones

Assign a **Type** to each slice:

| Type | Meaning |
|------|---------|
| **AFK** | Agent can implement and open PR without a human |
| **HITL** | Design decision, review, or manual verification required |

Prefer AFK when possible.

### 3. User confirmation

Present a numbered list. For each slice:

- **Title**
- **Type**: HITL / AFK
- **Blocked by**: dependent slices (or None)
- **User stories covered** (if any)

Confirm:

- Is granularity right?
- Are dependencies correct?
- Split / merge requests?
- HITL / AFK assignment?

Iterate until approved.

### 4. Publish (dependency order)

Publish blockers first so `Blocked by` can reference real `#n` values.

**Do not attach labels by default** (category `enhancement` / `bug` and `ready-to-build` add
little value mechanically). Mark a slice ready for an AFK agent via the Web UI **Build** button
(shown until a PR is in progress or merged), or pass `--label ready-to-build` **only** when the user
explicitly asks. To group the slices under a theme, pass that theme label (e.g. `ui-v3`) when the
user names one.

CLI example (no labels — the default):

```sh
lh issue create --repo <repo> --title "<slice title>" \
  --body "$(cat <<'EOF'
<body from template>
EOF
)" --actor triage-bot
```

When a parent issue exists, link `#<parent>` in the parent section (conversation-language heading) on
each child body.

**Do not close or rewrite the parent issue.**

### 5. Report (stop here)

Report created issues (number, title, Type, Blocked by) and recommended start order, then **stop**. Do
not start any slice unless the user asked to implement.

## Issue body template

```markdown
## Parent

#<parent issue number> (omit this section if no parent)

## What to build

End-to-end behavior for this vertical slice. Describe done behavior, not layer-by-layer steps.

Avoid file paths. Exception: inline types, schemas, or state machines confirmed in a prototype.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

None — can start immediately

<!-- or: #12, #34 -->
```

## Follow-on work (user must ask explicitly)

```text
lh-plan-to-issues → [stop] → (separate request) implementation → ...
```

Do **not** auto-start implementation right after publish. Optional guidance:

```text
To implement: start implementation on issue <n> (a separate request)
```

## Prohibited

- Do not implement, open PRs, or merge inside this skill
- Do not auto-start the first slice after publish
- Do not start implementation without user consent
- Do not close the parent issue without permission
