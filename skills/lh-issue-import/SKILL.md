---
name: lh-issue-import
description: >-
  Import a GitHub issue into LoopHub via lh issue import, copying its title/body verbatim and linking
  it to the GitHub source, then STOP. Use when the user runs /lh-issue-import, gives a GitHub issue
  URL to import, asks to import/取り込み a GitHub issue into LoopHub, or GitHub issue をインポート —
  NOT when they ask to implement or fix the imported issue.
---

# LoopHub GitHub issue import

Import a **GitHub issue** into LoopHub as a new issue: copy its **title and body verbatim** (no
summarization) and record the GitHub source link. **Stop after reporting the created issue. Do not
implement, branch, edit code, or chain to other skills** unless the user explicitly asks in a
separate message.

## Scope boundary (read first)

**This skill ends when the LoopHub issue is created from the GitHub source and reported.** Importing
does **not** include implementing the issue, opening a PR, or syncing anything back to GitHub.

| Do | Do not |
|----|--------|
| Take a GitHub issue URL, run `lh issue import`, report the created LoopHub issue | Start implementation or open a PR |
| Optionally help the user sharpen Goal / Acceptance criteria / Out of scope **on the created issue** (see below) | Summarize or rewrite the body during import (the copy is verbatim) |
| **Suggest** follow-on work (Start workflow) in text | **Continue** to follow-on work yourself |

### Done when

Stop **immediately** when all of the following are true:

- [ ] `lh issue import <github-issue-url>` succeeded — a new LoopHub issue was created with the GitHub title/body copied, and the GitHub source link recorded
- [ ] The created LoopHub issue `#number` and its Web URL reported to the user

## Invocation

`/lh-issue-import <github-issue-url>` — the URL of the GitHub issue to import (e.g.
`https://github.com/owner/repo/issues/42`). If the URL is omitted, ask the user for it; do not guess.

The destination LoopHub repo is the one resolved from `--repo owner/name` or the current directory
(same as other `lh issue` commands). If it is ambiguous which LoopHub repo to import into, ask.

## Requirements

- **`gh` CLI must be installed and authenticated** — `lh issue import` fetches the GitHub issue via
  `gh issue view`. If `gh` is missing or unauthenticated, the command fails with the underlying `gh`
  error; report it and ask the user to run `gh auth login` rather than retrying blindly.
- The URL must be a GitHub **issue** URL (`/issues/<n>`). A `/pull/<n>` URL is rejected — importing a
  PR as an issue is out of scope.

## Procedure

### 1. Import

```sh
lh issue import <github-issue-url> --repo <owner/repo>
```

This one command does the whole import in core: parse the URL → fetch the issue via `gh` → create a
LoopHub issue copying title/body verbatim → record the `github_issues` link. It prints
`imported #<n> from <github-url>`. The same GitHub issue may be imported more than once — each import
creates a **new** LoopHub issue linked to that GitHub source (the link is many-to-one by design), so
do not treat a second import as an error.

Verify with `lh issue view <n> --repo <owner/repo>` if you want to confirm the copied body.

### 2. Clarify (optional, case-by-case)

The GitHub body is copied **as-is**. If it lacks a clear Goal / Acceptance criteria / Out of scope and
the user wants it AFK-ready, help sharpen it — but only when it adds value, and **ask the user** when
a decision is genuinely ambiguous rather than inventing scope. Apply refinements with
`lh issue update <n> --repo <owner/repo> --body "..."`. This step is judgement, not a checklist:
skip it entirely for a body that is already actionable.

Do **not** take ownership of the issue (open a PR, create a worktree, or edit source) — that is a
Workflow run's job (Start workflow), in a separate explicit request.

### 3. Report

- Created LoopHub issue `#<n>` and its title
- The GitHub source URL it was imported from
- Issue Web URL (`{baseUrl}/r/{owner}/{repo}/issues/{n}`) as a markdown link — get `baseUrl` from
  `lh info --json | jq -r .baseUrl`

Then **stop**. If the user wants it implemented, they start a Workflow run (Start workflow) for it
as a separate step.

## Language

This skill is issue-only (no PR yet), so localize **reader-facing output** (the report, any clarifying
questions, and refined issue text) to the **conversation language**. CLI, code, and identifiers stay
English. The imported title/body is copied verbatim in whatever language the GitHub issue used — do
not translate it.

## Prohibited

- Do not summarize, translate, or rewrite the GitHub body during import (verbatim copy)
- Do not implement, branch, or open a PR for the imported issue without a separate explicit request
- Do not chain to a Workflow run (Start workflow) or other skills automatically
- Do not sync anything back to GitHub (import is one-way)
