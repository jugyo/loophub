---
name: lh-create-github-pr
description: >-
  Submit a LoopHub PR to GitHub as a Draft PR, then record it back into LoopHub. Use when the user
  runs /lh-create-github-pr {pr id}, clicks "Create PR on GitHub" in the PR detail, or asks to
  create/submit/open a GitHub PR from a LoopHub PR. Does not merge or review the GitHub PR.
---

# Submit a LoopHub PR to GitHub

Create a **GitHub Draft PR** from an existing LoopHub PR, then **record it back** into LoopHub so the
PR detail switches from "Create PR on GitHub" to "View PR on GitHub". **Stop after recording and
reporting. Do not merge or review the GitHub PR, and do not chain to other skills.**

## Quickstart

1. Read the LoopHub PR with `lh pr view <pr id> --repo <owner/name> --json`.
2. Confirm it does not already have `github_pull`.
3. Generate a content-based GitHub branch name, English title, and template-driven description.
4. Run `lh pr create-github-pr <pr id> --repo <owner/name> --branch <branch> --title <title> --body -`.
5. Verify `github_pull` is now set, report the GitHub Draft PR URL, then stop.

## Scope boundary (read first)

**This skill ends once the GitHub Draft PR is recorded and reported.** Submitting a PR to GitHub does
**not** include merging it, requesting reviews, or running the LoopHub review loop.

| Do | Do not |
|----|--------|
| Generate branch name, title (English), description; run `lh pr create-github-pr` once | Merge or review the GitHub PR |
| Read the loophub PR (`lh pr view --json`) for the double-create guard and generation context | Edit source in the worktree (submit only — no code changes) |
| Let the command push the branch / open the Draft PR / record it | Hand-run `git push` / `gh pr create` / `lh pr record-github-pr` yourself, or `cd` into the worktree |

### Done when

Stop **immediately** when all of the following are true:

- [ ] `lh pr create-github-pr` succeeded — it pushed the branch, opened the GitHub **Draft** PR, and recorded it (the loophub PR now carries a `github_pull`)
- [ ] The GitHub PR URL/number reported to the user (and the PR detail now shows "View PR on GitHub")

## Invocation

`/lh-create-github-pr <pr id>` — the LoopHub PR number to submit to GitHub. The PR detail's **Create PR on GitHub**
button dispatches this slash command through the configured coding agent in the built-in terminal
(cwd = repo root):

```text
/lh-create-github-pr <pr id>
```

The terminal opens at the **repo root** (`owner/name`), not inside the PR worktree — and it stays
there: `lh pr create-github-pr` resolves the branch/worktree location internally, so this skill no
longer `cd`s anywhere. If the id is omitted, ask the user for the LoopHub PR number; do not guess.

### Compatibility alias

`/create-github-pr <pr id>` remains available as a deprecated compatibility alias in
`skills/create-github-pr/`. New UI launches, docs, and customizable/selectable workflow-skill lists
should use `/lh-create-github-pr` so all LoopHub workflow skills share the `lh-*` naming convention.

## Design constraints (#406)

- **Leave minimal LoopHub traces on GitHub.** Use a normal, content-based branch name (e.g.
  `feature/...`), **not** the internal `loophub/issue-<n>` branch. The GitHub PR description is written
  from the repo's PR template / the change itself — it does **not** carry LoopHub boilerplate, the
  `Closes #<n>` line that points at the LoopHub issue, or a LoopHub-flavored Evidence section.
- **Commit trailers are an accepted tradeoff** — do **not** squash, rebase, or rewrite history to strip
  trailers from existing commits (#406 chose "don't reshape"). Push the branch's commits as they are.
- **Draft only.** Create the GitHub PR as a Draft; promoting it to ready and merging are out of scope.
- **Title in English by default** (the GitHub audience is external), regardless of the LoopHub PR's
  language. The description follows the repo's PR template; keep it in the template's language (English
  fallback when no template exists).

## LoopHub

- **Server**: default `http://localhost:8730` (`~/.loophub/config.json`)
- **CLI**: `lh` (on PATH)
- `--repo owner/name` — pass it explicitly. The terminal opens at the repo root, but the command's
  worktree/branch resolution and the double-create guard read are unambiguous when the repo is named.

### GitHub CLI

- `gh` must be installed and authenticated (`gh auth status`). If not, stop and tell the user to run
  `gh auth login` — do not attempt to create the PR by other means.

### Web URL (for reporting)

| Kind | Format |
|------|--------|
| PR (LoopHub) | `{baseUrl}/r/{owner}/{repo}/pulls/{m}` |

- **baseUrl**: `lh info --json | jq -r .baseUrl` (do **not** read `~/.loophub/config.json` directly —
  `lh info` applies the canonical resolution order: `LOOPHUB_URL` → config `url` →
  `http://localhost:${LOOPHUB_PORT:-8730}`)
- **owner/repo**: `--repo`, or repo resolution from cwd

## Procedure

The git/`gh`/record orchestration now lives in **one command** — `lh pr create-github-pr` (#411).
This skill only does the LLM work (branch name, English title, template-driven description) and hands
the results to that command, which pushes the branch, opens the GitHub **Draft** PR, and records it
back **atomically** (if recording ever fails after the GitHub PR is created, a re-run recovers the
existing PR instead of opening a duplicate). Do **not** hand-run `git push` / `gh pr create` /
`lh pr record-github-pr`, and do **not** `cd` into the worktree.

### 1. Read the LoopHub PR (guard + generation context)

```sh
lh pr view <pr id> --repo <owner/name> --json
```

Pull these fields:

| Field | Use |
|-------|-----|
| `title` / `body` / `linked_issue` | Context for generating the GitHub title and description |
| `github_pull` | **Double-create guard** — if non-null, the PR already has a GitHub PR |
| `merge_mode` | Should be `github_pr`; warn if not (the repo may not be in GitHub mode) |

You do **not** need `base.ref` / `head.ref` / `worktree_path` — the command resolves base, the internal
head branch, and the location itself.

**Already on GitHub?** If `github_pull` is non-null, **stop**: report the existing GitHub PR URL/number
and do nothing else (the UI already shows "View PR on GitHub"; re-running would duplicate). The
command also refuses a PR that already has a GitHub PR, but check here so non-UI launches stop early.

Confirm `gh` is authenticated (the command shells out to it):

```sh
gh auth status                # must be authenticated
```

If `gh` is missing or unauthenticated, stop and ask the user to run `gh auth login`.

### 2. Generate a content-based branch name

Choose a short, conventional branch name that reflects the change — **not** `loophub/issue-<n>` (the
command rejects an internal `loophub/*` name). Prefer a `type/slug` form matching the repo's convention
(e.g. `feature/github-pr`, `fix/merge-mode-default`). Derive the slug from the PR title / change;
keep it lowercase, hyphenated, ASCII. If unsure of the repo's branch convention, default to
`feature/<slug>`.

### 3. Write the title and description

Title is generated from the change, **in English by default** (the GitHub audience is external).

For the description, look for a PR template, in this order, and fill it for the change:

```sh
ls .github/PULL_REQUEST_TEMPLATE.md \
   .github/pull_request_template.md \
   .github/PULL_REQUEST_TEMPLATE/*.md \
   PULL_REQUEST_TEMPLATE.md \
   docs/PULL_REQUEST_TEMPLATE.md 2>/dev/null
```

- **Template found** → follow its sections/checklist; write real content (not placeholders), in the
  template's language.
- **No template** → fall back to a concise default: a short **Summary** of what changed and why, and a
  **Test plan** line. Keep it in English.

Do **not** include LoopHub boilerplate, the `Closes #<loophub-issue>` line, or a LoopHub Evidence
block — this is an external GitHub PR (see Design constraints).

### 4. Run the submit command

Pipe the generated description in via `--body -` (stdin) to avoid shell-escaping a multi-line body:

```sh
lh pr create-github-pr <pr id> --repo <owner/name> \
  --branch "<new-branch>" \
  --title "<English title>" \
  --body - <<'EOF'
<description from step 3>
EOF
```

The command pushes the selected branch name to GitHub, opens a **Draft** PR, records it back into
LoopHub, and prints `created GitHub PR #<N> — <url>` (`--json` for the full object). It is atomic and
idempotent: if a prior run created the GitHub PR but failed to record, re-running finds that PR and
records it rather than creating a second one.

### 5. Verify the switch and report

```sh
lh pr view <pr id> --repo <owner/name> --json | jq '.github_pull'
```

`github_pull` must now be non-null (number + url). This is what flips the PR detail button from
**Create PR on GitHub** to **View PR on GitHub** (#407).

Report:

- GitHub PR **URL and number** (Draft)
- The **branch name** pushed to GitHub
- The LoopHub PR Web URL (format above) as a markdown link
- Confirmation that the button now shows **View PR on GitHub**

Then **stop** — the GitHub PR is created.

## Error handling

| Symptom | Cause | Remedy |
|---------|-------|--------|
| `github_pull` already set in step 1 | PR already has a GitHub PR | Report the existing GitHub PR; stop (no duplicate) |
| `gh auth status` fails | `gh` not authenticated | Stop; ask user to run `gh auth login` |
| Command errors `repo has no GitHub origin remote` | Repo has no GitHub `origin` | Stop; the repo isn't set up for GitHub |
| Command errors `already has a GitHub PR (#…)` | PR already recorded | Report the existing GitHub PR; stop (no duplicate) |
| `merge_mode` is not `github_pr` | Repo not in GitHub mode | Warn; confirm with the user before submitting |

`lh pr create-github-pr` handles the double-create safeguard itself (#411): it refuses an
already-recorded PR (the `github_pull` guard), and if a prior run created the GitHub PR but failed
before recording, **re-running recovers** that PR (it finds the open PR for the branch and records it)
rather than opening a second one. The **step-1 `github_pull` non-null guard** is the early, user-facing
stop for non-UI launches; the command is the authoritative safeguard.

## Implementation notes

This is the **(B) skill side** of #406. The **(A) LoopHub side** (per-repo `github_pr` merge mode, the
`github_pulls` data model, the `lh pr record-github-pr` API, and the `lh pr create-github-pr`
orchestration that pushes + opens + records in one atomic command — #411) is already implemented
(#407/#411). This skill only generates the branch/title/description and invokes that one command.

For contributors: the web action dispatches the `github-pr-export` terminal workflow, which maps to
`/lh-create-github-pr <pr id>`. The JSON-RPC method `pulls/createGithubPull` calls the same core
orchestration as `lh pr create-github-pr`: it pushes `<internal head>:refs/heads/<new-branch>` to the
GitHub `origin` **without** `-u`, opens the Draft PR with the LoopHub PR's base, and records the 1:1
GitHub PR row in `github_pulls`.

## Prohibited

- Do not merge, review, or mark the GitHub PR ready
- Do not edit source or commit changes in the worktree (submit only)
- Do not squash, rebase, or rewrite history to strip commit trailers (#406: "don't reshape")
- Do not run the LoopHub review loop (`lh-pr-review`) or merge-ready check
- Do not push the internal `loophub/issue-<n>` branch as the GitHub branch (use a content-based name)
- Do not include LoopHub boilerplate / `Closes #<n>` / Evidence in the GitHub PR description
- Do not create a second GitHub PR for one that already has a `github_pull` (double-create)
