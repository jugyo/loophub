# LoopHub agent skills

Skill `name` values use **lowercase letters, digits, and hyphens (`-`) only**. `name` = directory name =
chat invocation (e.g. `/lh-pr-review`). These skills are **host-agnostic**: they run under Cursor,
Claude Code, or any agent host that supports `/name` invocation and readonly subagents (the install
script symlinks them into `~/.claude/skills/`).

| Skill `name` | Directory | Invocation |
|--------------|-------------|------------|
| `lh-repo-add` | `skills/lh-repo-add/` | `/lh-repo-add` (register local git checkout) |
| `lh-issue-create` | `skills/lh-issue-create/` | `/lh-issue-create` |
| `lh-plan-to-issues` | `skills/lh-plan-to-issues/` | `/lh-plan-to-issues` |
| `lh-dev` | `skills/lh-dev/` | `/lh-dev {issue id}` (implement → PR → review loop; `lh dev` provisions the worktree) |
| `lh-pr-review` | `skills/lh-pr-review/` | `/lh-pr-review {pr id}` (review → fix → re-review loop) |
| `lh-rebase-conflict` | `skills/lh-rebase-conflict/` | `/lh-rebase-conflict {pr id}` (resolve conflicts → re-review) |
| `lh-merge-ready` | `skills/lh-merge-ready/` | `/lh-merge-ready {pr id}` (pre-merge check; human merges) |
| `lh-retro` | `skills/lh-retro/` | `/lh-retro [{pr id}]` (retrospect a merged PR / backfill → save to retros DB) |
| `lh-review-notes` | `skills/lh-review-notes/` | `/lh-review-notes [{base..commit}]` (per-file fact-based notes from the diff → save to review_notes) |

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## Authoring

- **Language**: SKILL.md **body** (after YAML frontmatter) is **English only**. Non-English routing
  triggers (e.g. 起票) belong in the YAML `description` field only.
- **Issue/PR output**: Skills with a `## Language` section localize **reader-facing text** to the
  user's language — do not embed localized templates in the skill body. For **PR-flow** output (PR
  body, review comments, `review_notes`, hand-off summaries), the target language is the **PR's
  language**, resolved in this order: linked issue → human-authored PR body/title → conversation →
  English fallback. Each skill states this rule inline in its own `## Language` section so it stays
  self-contained and host-portable (see `lh-dev` and `lh-pr-review`); keep the order consistent when
  editing them. For **issue-only** skills with no PR yet (`lh-issue-create`, `lh-plan-to-issues`),
  there is nothing to resolve against — localize the issue text to the **conversation language**.
  Interactive, non-persisted reports a skill prints back to the operator (e.g. `lh-merge-ready`'s
  pre-merge `## Report`) are session output, not a stored PR artifact, so they intentionally follow the
  **conversation language** too — by design, not an oversight.
- **PR evidence**: PR bodies require an **Evidence** section (test output excerpts, screenshots for UI,
  CLI snippets, or explicit N/A). Enforced at PR creation — see `lh-dev` § PR (step 5).
- **Reviewers are role-based, not vendor-based**: reference review subagents by **role** (Quality,
  Security), never by a product name. `lh-pr-review` § Reviewer roles & host mapping resolves each
  role to a host mechanism (Cursor `bugbot`/`security-review`, Claude Code `code-reviewer`/`general-purpose`
  + `/security-review`) with a `general-purpose` fallback so a missing vendor reviewer never blocks review.

## Evidence screenshots

UI / visual evidence (screenshots) is stored in a **persistent evidence directory** so it
survives worktree removal and session / temp cleanup — and is therefore still present when
`lh-merge-ready` runs at the end of the chain:

```text
${LOOPHUB_HOME:-$HOME/.loophub}/evidence/<owner>/<repo>/issue-<n>/
```

- **Key by issue number** (`issue-<n>`, from the `loophub/issue-<n>` head branch) so every step
  in the chain — dev, review, merge-ready — resolves the same directory. For a PR with no linked
  issue, use `pr-<m>` instead.
- Do **not** keep UI evidence only under the session scratchpad / `$TMPDIR` or inside the
  worktree — both can be cleared before merge-ready, losing the evidence. Copy or write it into
  the directory above.
- Filenames: a short descriptive slug, no spaces, `.png` (e.g. `home-recent-open-issues.png`).
- `lh-dev` (§4) and `lh-pr-review` (Phase B) write here; `lh-merge-ready` reads the directory,
  validates each image, and prints the valid paths at the end of its report.

## Skill chain

```text
repo-add (one-time) → issue-create / plan-to-issues
  → lh-dev (implement → PR → review loop) → merge-ready → (human merge)

rebase-conflict resolves conflicts on a PR head, then resumes pr-review.
```

`lh-dev` drives implementation (launched by `lh dev`, which provisions the issue worktree and opens the
linked PR — the PR's existence is the "taken" signal, the session is attributed to the PR row); these
skills cover registration, issue authoring, implementation, review, conflict resolution, and the
pre-merge check.

## Head worktree bootstrap

Skills that work on a PR head (pr-review, rebase-conflict) must **not**
`git checkout head.ref` on the repo root (main checkout). Shared procedure:

1. Record `head.ref` and repo absolute path (`local_path`) from `lh pr view <m>`
2. If cwd is already `local_path/.worktrees/<head.ref>`, continue
3. Else `cd local_path` and check `.worktrees/<head.ref>`:
   - Exists → `cd .worktrees/<head.ref>`
   - Missing → `git worktree add .worktrees/<head.ref> <head.ref>` then `cd`
4. Inside a worktree, **`--repo owner/name` is required** (`resolveRepo()` omits only when cwd is repo root)
5. Pass **working cwd (worktree absolute path)** as the reviewer subagents' repository path
   (see `lh-pr-review` § Reviewer roles & host mapping)

Shared shell snippet (substitute `local_path` and `<head.ref>`):

```sh
ROOT="<local_path>"
WT="$ROOT/.worktrees/<head.ref>"
if [ "$(pwd -P)" = "$(cd "$WT" 2>/dev/null && pwd -P)" ]; then
  : # already in target worktree
elif [ -d "$WT" ]; then
  cd "$WT"
else
  git -C "$ROOT" worktree add ".worktrees/<head.ref>" <head.ref> && cd "$WT"
fi
```

rebase-conflict may reuse an existing worktree.

## Install

Run the install script from this repo root — it symlinks every skill into `~/.claude/skills/`:

```sh
./skills/install.sh
```

Or do it by hand (`-sfn` so an existing symlink is replaced, not nested inside a directory):

```sh
for s in lh-repo-add lh-issue-create lh-plan-to-issues lh-dev \
  lh-pr-review lh-rebase-conflict lh-merge-ready; do
  ln -sfn "$PWD/skills/$s" "$HOME/.claude/skills/$s"
done
```
