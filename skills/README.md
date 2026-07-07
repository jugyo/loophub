# LoopHub agent skills

Skill `name` values use **lowercase letters, digits, and hyphens (`-`) only**. `name` = directory name =
chat invocation (e.g. `/lh-pr-review`). These skills are **host-agnostic**: they run under Codex,
Cursor, Claude Code, or any agent host that supports `/name` invocation and readonly,
context-isolated reviewer sessions (install them with `npx skills add`).

| Skill `name` | Directory | Invocation |
|--------------|-------------|------------|
| `lh-repo-add` | `skills/lh-repo-add/` | `/lh-repo-add` (register local git checkout) |
| `lh-issue-create` | `skills/lh-issue-create/` | `/lh-issue-create` |
| `lh-issue-import` | `skills/lh-issue-import/` | `/lh-issue-import {github-issue-url}` (copy a GitHub issue into LoopHub → link) |
| `lh-plan-to-issues` | `skills/lh-plan-to-issues/` | `/lh-plan-to-issues` |
| `lh-dev` | `skills/lh-dev/` | `/lh-dev {issue id}` (implement → PR → review loop; `lh dev` provisions the worktree) |
| `lh-pr-review` | `skills/lh-pr-review/` | `/lh-pr-review {pr id}` (review → fix → re-review loop) |
| `lh-rebase-conflict` | `skills/lh-rebase-conflict/` | `/lh-rebase-conflict {pr id}` (resolve conflicts → re-review) |
| `lh-merge-ready` | `skills/lh-merge-ready/` | `/lh-merge-ready {pr id}` (pre-merge check; human merges) |
| `lh-retro` | `skills/lh-retro/` | `/lh-retro [{pr id}]` (retrospect a merged PR / backfill → save to retros DB) |
| `lh-create-github-pr` | `skills/lh-create-github-pr/` | `/lh-create-github-pr {pr id}` (export a LoopHub PR to a GitHub Draft PR → record back) |
| `create-github-pr` | `skills/create-github-pr/` | `/create-github-pr {pr id}` (deprecated compatibility alias for `lh-create-github-pr`) |

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

`lh-create-github-pr` is part of the selectable `lh-*` LoopHub workflow-skill set. The PR detail's
**Create PR on GitHub** button dispatches `/lh-create-github-pr <pr>` through the configured coding
agent.
`create-github-pr` remains as a deprecated compatibility alias for users or installed agents that
still invoke `/create-github-pr <pr>` directly; do not add it to new customization pickers.

## Authoring

- **Language**: SKILL.md **body** (after YAML frontmatter) is **English only**. Non-English routing
  triggers (e.g. 起票) belong in the YAML `description` field only.
- **Issue/PR output**: Skills with a `## Language` section localize **reader-facing text** to the
  user's language — do not embed localized templates in the skill body. For **PR-flow** output (PR
  body, review comments, hand-off summaries), the target language is the **PR's language**, resolved
  in this order: linked issue → human-authored PR body/title → conversation → English fallback. Each
  skill states this rule inline in its own `## Language` section so it stays self-contained and
  host-portable (see `lh-dev` and `lh-pr-review`); keep the order consistent when editing them. For
  **issue-only** skills with no PR yet (`lh-issue-create`, `lh-plan-to-issues`), there is nothing to
  resolve against — localize the issue text to the **conversation language**.
  Interactive, non-persisted reports a skill prints back to the operator (e.g. `lh-merge-ready`'s
  pre-merge `## Report`) are session output, not a stored PR artifact, so they intentionally follow the
  **conversation language** too — by design, not an oversight.
- **PR evidence**: PR bodies require an **Evidence** section (test output excerpts, screenshots for UI,
  CLI snippets, or explicit N/A). Enforced at PR creation — see `lh-dev` § PR (step 5).
- **Reviewers are role-based, not vendor-based**: reference reviewers by **role** (Quality, Security,
  Documentation, Acceptance), never by a product name. `lh-pr-review` § Reviewer roles & host mapping
  resolves each role to a context-isolated host mechanism (Codex `codex exec`, Cursor
  `bugbot`/`security-review`, Claude Code `code-reviewer`/`general-purpose` + `/security-review`) with
  an isolated `general-purpose` fallback so a missing vendor reviewer never blocks review.
  Documentation runs only for changed documentation files and checks reader fit, not implementation
  correctness.

## Skill chain

```text
repo-add (one-time) → issue-create / plan-to-issues
  → lh-dev (implement → PR → review loop) → merge-ready → (human merge)

rebase-conflict resolves conflicts on a PR head, then resumes pr-review.
```

`lh-dev` drives implementation (launched by `lh dev`, which opens the linked PR and provisions its
PR-keyed worktree (`pr-<m>`, #463) — the PR's existence is the "taken" signal, the session is
attributed to the PR row); these
skills cover registration, issue authoring, implementation, review, conflict resolution, and the
pre-merge check.

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
npx skills add owner/repo --skill lh-dev  # install one skill by name
```
