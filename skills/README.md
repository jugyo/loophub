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
| `loophub-dev` | `skills/loophub-dev/` | `/loophub-dev {issue id}` (implement → PR → review loop; `lh dev` provisions the worktree) |
| `lh-pr-review` | `skills/lh-pr-review/` | `/lh-pr-review {pr id}` (review → fix → re-review loop) |
| `lh-rebase-conflict` | `skills/lh-rebase-conflict/` | `/lh-rebase-conflict {pr id}` (resolve conflicts → sync) |
| `lh-merge-ready` | `skills/lh-merge-ready/` | `/lh-merge-ready {pr id}` (pre-merge check; human merges) |

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## Authoring

- **Language**: SKILL.md **body** (after YAML frontmatter) is **English only**. Non-English routing
  triggers (e.g. 起票) belong in the YAML `description` field only.
- **Issue/PR output**: Skills with a `## Language` section localize **issue and PR text** to the user's
  conversation language — do not embed localized templates in the skill body.
- **PR evidence**: PR bodies require an **Evidence** section (test output excerpts, screenshots for UI,
  CLI snippets, or explicit N/A). See `lh-merge-ready` §3.5.
- **Reviewers are role-based, not vendor-based**: reference review subagents by **role** (Quality,
  Security), never by a product name. `lh-pr-review` § Reviewer roles & host mapping resolves each
  role to a host mechanism (Cursor `bugbot`/`security-review`, Claude Code `code-reviewer`/`general-purpose`
  + `/security-review`) with a `general-purpose` fallback so a missing vendor reviewer never blocks review.

## Skill chain

```text
repo-add (one-time) → issue-create / plan-to-issues
  → loophub-dev (implement → PR → review loop) → merge-ready → (human merge)

rebase-conflict resolves conflicts on a PR head, then resumes pr-review.
```

`loophub-dev` drives implementation (launched by `lh dev`, which provisions the issue worktree and
assigns the issue); these skills cover registration, issue authoring, implementation, review, conflict
resolution, and the pre-merge check. The `lh-*` prefix names are installed skills, while `loophub-dev`
is a repo-external skill.

## Head worktree bootstrap

Skills that work on a PR head (pr-review, merge-ready, rebase-conflict) must **not**
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
for s in lh-repo-add lh-issue-create lh-plan-to-issues loophub-dev \
  lh-pr-review lh-rebase-conflict lh-merge-ready; do
  ln -sfn "$PWD/skills/$s" "$HOME/.claude/skills/$s"
done
```
