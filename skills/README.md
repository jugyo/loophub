# LoopHub agent skills

Skill `name` values use **lowercase letters, digits, and hyphens (`-`) only**. `name` = directory name =
chat invocation (e.g. `/lh-rebase-conflict`). These skills are **host-agnostic**: they run under Codex,
Cursor, Claude Code, or any agent host that supports `/name` invocation and readonly,
context-isolated reviewer sessions (install them with `npx skills add`).

| Skill `name` | Directory | Invocation |
|--------------|-------------|------------|
| `lh-repo-add` | `skills/lh-repo-add/` | `/lh-repo-add` (register local git checkout) |
| `lh-issue-create` | `skills/lh-issue-create/` | `/lh-issue-create` |
| `lh-issue-import` | `skills/lh-issue-import/` | `/lh-issue-import {github-issue-url}` (copy a GitHub issue into LoopHub → link) |
| `lh-inbox` | `skills/lh-inbox/` | `/lh-inbox` (send, inspect, and update LoopHub Inbox messages) |
| `lh-plan-to-issues` | `skills/lh-plan-to-issues/` | `/lh-plan-to-issues` |
| `lh-scheduled-task-create` | `skills/lh-scheduled-task-create/` | `/lh-scheduled-task-create` (create a scheduled task → verify → stop) |
| `lh-rebase-conflict` | `skills/lh-rebase-conflict/` | `/lh-rebase-conflict {pr id}` (resolve conflicts → re-review) |
| `lh-retro` | `skills/lh-retro/` | `/lh-retro [{pr id}]` (retrospect a merged PR / backfill → save to retros DB) |
| `lh-create-github-pr` | `skills/lh-create-github-pr/` | `/lh-create-github-pr {pr id}` (export a LoopHub PR to a GitHub Draft PR → record back) |

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

`lh-create-github-pr` is part of the selectable `lh-*` LoopHub workflow-skill set. The PR detail's
**Create PR on GitHub** button dispatches `/lh-create-github-pr <pr>` through the configured coding
agent.

## Authoring

- **Language**: SKILL.md **body** (after YAML frontmatter) is **English only**. Non-English routing
  triggers (e.g. 起票) belong in the YAML `description` field only.
- **Issue/PR output**: Skills with a `## Language` section localize **reader-facing text** to the
  user's language — do not embed localized templates in the skill body. For **PR-flow** output (PR
  body, review comments, hand-off summaries), the target language is the **PR's language**, resolved
  in this order: linked issue → human-authored PR body/title → conversation → English fallback. A
  PR-flow skill should state this resolution order inline in its own `## Language` section so it stays
  self-contained and host-portable; keep the order consistent when editing them. (No skill currently
  ships this order — the surviving skills below are issue-only or conversation-language reports.) For
  **issue-only** skills with no PR yet (`lh-issue-create`, `lh-plan-to-issues`), there is nothing to
  resolve against — localize the issue text to the **conversation language**.
  Interactive, non-persisted reports a skill prints back to the operator (a skill's pre-merge or
  hand-off `## Report`) are session output, not a stored PR artifact, so they intentionally follow the
  **conversation language** too — by design, not an oversight.
- **PR evidence**: PR bodies require an **Evidence** section (test output excerpts, screenshots for UI,
  CLI snippets, or explicit N/A). The draft PR is seeded with an Evidence placeholder when the
  Workflow run opens it, and the Execute step fills it in before marking the PR ready.

## Skill chain

```text
repo-add (one-time) → issue-create / plan-to-issues
  → Start workflow (Workflow run: implement → PR → Verify review) → (human merge)

scheduled-task-create is a standalone operations path: create scheduled task → verify → stop.
rebase-conflict resolves conflicts on a PR head, then the PR is re-reviewed by the Verify step.
```

A **Workflow run** drives implementation (started via the Web UI **Start workflow** control, i.e.
`lh workflow start`, which opens the linked PR and provisions its PR-keyed worktree (`pr-<m>`, #463) —
the PR's existence is the "taken" signal, the session is attributed to the PR row). Its Execute step
implements and the Verify step reviews. These skills cover registration, issue authoring,
scheduled-task registration, and conflict resolution; implementation and review are the Workflow
run's job (Execute and Verify steps), not standalone skills.

`lh-create-github-pr` is **outside** this chain: it is a separate, UI-triggered export action (the PR
detail's **Create PR on GitHub** button for repos in `github_pr` merge mode). It pushes the PR's branch
under a content-based name, opens a GitHub **Draft** PR, and records it back with
`lh pr record-github-pr` so the button switches to **View PR on GitHub**. It does not merge or review.
`lh pr record-github-pr <pr-id> --url <github-pr-url>` can also be run directly to attach a GitHub
PR that was created outside LoopHub (e.g. via `gh pr create`) back onto its LoopHub PR (#487) — the
GitHub PR number is derived from the URL when `--number` is omitted.

## Install

Install with `npx skills add`, which matches the layout the
[`skills` CLI](https://github.com/vercel-labs/skills) expects (`skills/<name>/SKILL.md`). Review a
skill before installing — it becomes instructions your agent follows.

```sh
npx skills add owner/repo                 # from GitHub
npx skills add .                          # from a local checkout (this repo's root)
npx skills add owner/repo --skill lh-rebase-conflict  # install one skill by name
```
