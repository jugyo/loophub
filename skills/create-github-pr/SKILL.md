---
name: create-github-pr
description: >-
  Export a LoopHub PR to GitHub: push the head branch under a content-based name, write a description
  from the repo PR template, open a GitHub Draft PR, and record it back with lh pr record-github-pr.
  Use when the user runs /create-github-pr {pr id}, clicks "Create PR on GitHub" in the PR detail, or
  asks to create/export/open a GitHub PR from a LoopHub PR. Does not merge or review the GitHub PR.
---

# LoopHub → GitHub PR export

Create a **GitHub Draft PR** from an existing LoopHub PR, then **record it back** into LoopHub so the
PR detail switches from "Create PR on GitHub" to "View PR on GitHub". **Stop after recording and
reporting. Do not merge or review the GitHub PR, and do not chain to other skills.**

This is the **(B) skill side** of #406. The **(A) LoopHub side** (per-repo `github_pr` merge mode, the
`github_pulls` data model, and the `lh pr record-github-pr` API) is already implemented (#407). This
skill only creates the GitHub PR and records it.

## Scope boundary (read first)

**This skill ends once the GitHub Draft PR is recorded and reported.** Exporting a PR does **not**
include merging it, requesting reviews, or running the LoopHub review loop.

| Do | Do not |
|----|--------|
| Push a content-named branch, open a GitHub **Draft** PR, record it with `lh pr record-github-pr` | Merge or review the GitHub PR |
| Read the loophub PR (`lh pr view --json`) to resolve base/head/worktree | Edit source in the worktree (export only — no code changes) |
| Generate branch name, title (English), description from the PR template | Push the internal `loophub/issue-<n>` branch as-is to GitHub |

### Done when

Stop **immediately** when all of the following are true:

- [ ] A GitHub Draft PR exists for the loophub PR's branch (created via `gh pr create --draft`)
- [ ] `lh pr record-github-pr` succeeded — the loophub PR now carries a `github_pull`
- [ ] The GitHub PR URL/number reported to the user (and the PR detail now shows "View PR on GitHub")

## Invocation

`/create-github-pr <pr id>` — the LoopHub PR number to export. The PR detail's **Create PR on GitHub**
button dispatches exactly this command into the built-in terminal (cwd = repo root):

```text
claude "/create-github-pr <pr id>"
```

The terminal opens at the **repo root** (`owner/name`), not inside the PR worktree — this skill `cd`s
into the PR's worktree itself (step 2). If the id is omitted, ask the user for the LoopHub PR number;
do not guess.

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

- Server: default `http://localhost:8730` (`~/.loophub/config.json`)
- CLI: `lh` (on PATH)
- `--repo owner/name` — **required** here: this skill runs inside the PR worktree (outside the main
  checkout), so `resolveRepo()` cannot infer the repo from cwd.

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

## Procedure

### 1. Read the LoopHub PR

```sh
lh pr view <m> --repo <owner/name> --json
```

Pull these fields:

| Field | Use |
|-------|-----|
| `base.ref` | GitHub PR base branch (e.g. `main`) — the GitHub PR inherits the LoopHub PR's base |
| `head.ref` | LoopHub internal branch (e.g. `loophub/issue-<n>`) — the source commits to push, **not** the GitHub branch name |
| `worktree_path` | The PR's worktree directory to `cd` into |
| `title` / `body` / `linked_issue` | Context for generating the GitHub title and description |
| `github_pull` | **Double-create guard** — if non-null, the PR was already exported |
| `merge_mode` | Should be `github_pr`; warn if not (the repo may not be in GitHub mode) |

**Already exported?** If `github_pull` is non-null, **stop**: report the existing GitHub PR URL/number
and do nothing else (the LoopHub UI already shows "View PR on GitHub"; re-exporting would create a
duplicate). #407 also hides the Create button once recorded, but guard here too for non-UI launches.

### 2. Enter the PR worktree

```sh
cd "<worktree_path>"          # from step 1
git status                    # confirm on <head.ref>, tree clean
```

Verify `gh` is ready:

```sh
gh auth status                # must be authenticated
```

If `gh` is missing or unauthenticated, stop and ask the user to set it up (`gh auth login`). Do not
edit source here — the branch is exported as-is.

### 3. Generate a content-based branch name

Choose a short, conventional branch name that reflects the change — **not** `loophub/issue-<n>`.
Prefer a `type/slug` form matching the repo's convention (e.g. `feature/github-pr-export`,
`fix/merge-mode-default`). Derive the slug from the PR title / change; keep it lowercase, hyphenated,
ASCII. If unsure of the repo's branch convention, default to `feature/<slug>`.

### 4. Push the branch to GitHub

Push the head branch's commits under the new name without disturbing the local `loophub/issue-<n>`
branch (the LoopHub worktree keeps using it):

```sh
git push origin "<head.ref>:refs/heads/<new-branch>"
```

Do **not** pass `-u/--set-upstream`: it would rewrite the local `<head.ref>` branch's upstream to the
GitHub branch, disturbing the LoopHub-managed branch (a later bare `git push` in the worktree could then
target GitHub). Tracking is unnecessary — the exported branch is recorded via `lh pr record-github-pr
--branch` (step 7).

`origin` is the GitHub remote (confirm with `git remote -v`; pick the GitHub one if multiple). If the
remote branch already exists from a prior attempt, reuse it (or force-update only if you are sure it
maps to this PR's commits).

### 5. Write the description from the PR template

Look for a PR template, in this order, and fill it for the change:

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

### 6. Create the GitHub Draft PR

Title is generated from the change, **in English by default**. Base follows the LoopHub PR's
`base.ref`. Use a HEREDOC for the body:

```sh
gh pr create --draft \
  --base "<base.ref>" \
  --head "<new-branch>" \
  --title "<English title>" \
  --body "$(cat <<'EOF'
<description from step 5>
EOF
)"
```

`gh pr create` prints the new PR URL on success. Capture it; derive the number from the URL
(`.../pull/<N>`) or `gh pr view <new-branch> --json number,url`.

### 7. Record the GitHub PR back into LoopHub

```sh
lh pr record-github-pr <m> --repo <owner/name> \
  --number <N> --url <U> --branch <new-branch>
```

(RPC: `pulls/recordGithubPull`; stored in `github_pulls`, 1:1 with the PR — #407.) Pass `--branch` so
LoopHub knows the exported branch name.

### 8. Verify the switch and report

```sh
lh pr view <m> --repo <owner/name> --json | jq '.github_pull'
```

`github_pull` must now be non-null (number + url). This is what flips the PR detail button from
**Create PR on GitHub** to **View PR on GitHub** (#407).

Report:

- GitHub PR **URL and number** (Draft)
- Exported **branch name**
- The LoopHub PR Web URL (format above) as a markdown link
- Confirmation that the button now shows **View PR on GitHub**

Then **stop** — exporting is complete.

## Error handling

| Symptom | Cause | Remedy |
|---------|-------|--------|
| `github_pull` already set in step 1 | PR already exported | Report the existing GitHub PR; stop (no duplicate) |
| `gh auth status` fails | `gh` not authenticated | Stop; ask user to run `gh auth login` |
| `git push` rejected (no GitHub remote) | Repo has no GitHub `origin` | Stop; the repo isn't set up for GitHub export |
| `merge_mode` is not `github_pr` | Repo not in GitHub mode | Warn; confirm with the user before exporting |

`lh pr record-github-pr` is an **idempotent upsert** (`github_pulls` is 1:1 with the PR via
`ON CONFLICT(issue_id) DO UPDATE` — #407), so re-running step 7 does **not** error — it silently
**overwrites** the stored number/url/branch. The real double-create safeguard is the **step-1
`github_pull` non-null guard**: once it is set, stop and report the existing GitHub PR rather than
re-pushing / re-creating / re-recording.

## Out of scope (this skill)

- Merging, reviewing, or marking the GitHub PR ready
- Editing source / committing changes in the worktree (export only)
- Squashing or rewriting history to strip commit trailers (#406: "don't reshape")
- Running the LoopHub review loop (`lh-pr-review`) or merge-ready check

## Prohibited

- Do not merge or review the GitHub PR
- Do not push the internal `loophub/issue-<n>` branch as the GitHub branch (use a content-based name)
- Do not include LoopHub boilerplate / `Closes #<n>` / Evidence in the GitHub PR description
- Do not re-export a PR that already has a `github_pull` (double-create)
- Do not edit source in the worktree
