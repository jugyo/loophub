# LoopHub agent skills

Cursor skill `name` values use **lowercase letters, digits, and hyphens (`-`) only**. `name` = directory name =
chat invocation (e.g. `/loophub-pr-review`).

| Skill `name` | Directory | Invocation |
|--------------|-------------|------------|
| `loophub-repo-add` | `skills/loophub-repo-add/` | `/loophub-repo-add` (register local git checkout) |
| `loophub-issue-create` | `skills/loophub-issue-create/` | `/loophub-issue-create` |
| `loophub-plan-to-issues` | `skills/loophub-plan-to-issues/` | `/loophub-plan-to-issues` |
| `loophub-pr-review` | `skills/loophub-pr-review/` | `/loophub-pr-review {pr id}` (review → fix → re-review loop) |
| `loophub-rebase-conflict` | `skills/loophub-rebase-conflict/` | `/loophub-rebase-conflict {pr id}` (resolve conflicts → sync) |
| `loophub-merge-ready` | `skills/loophub-merge-ready/` | `/loophub-merge-ready {pr id}` (pre-merge check; human merges) |

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## Authoring

- **Language**: SKILL.md **body** (after YAML frontmatter) is **English only**. Non-English routing
  triggers (e.g. 起票) belong in the YAML `description` field only.
- **Issue/PR output**: Skills with a `## Language` section localize **issue and PR text** to the user's
  conversation language — do not embed localized templates in the skill body.
- **PR evidence**: PR bodies require an **Evidence** section (test output excerpts, screenshots for UI,
  CLI snippets, or explicit N/A). See `loophub-merge-ready` §3.5.

## Skill chain

```text
repo-add (one-time) → issue-create / plan-to-issues
  → (implementation) → pr-review → merge-ready → (human merge)

rebase-conflict resolves conflicts on a PR head, then resumes pr-review.
```

Implementation itself is driven manually (or by a separate session); these skills cover registration,
issue authoring, review, conflict resolution, and the pre-merge check.

## Head worktree bootstrap

Skills that work on a PR head (pr-review, merge-ready, rebase-conflict) must **not**
`git checkout head.ref` on the repo root (main checkout). Shared procedure:

1. Record `head.ref` and repo absolute path (`local_path`) from `lh pr view <m>`
2. If cwd is already `local_path/.worktrees/<head.ref>`, continue
3. Else `cd local_path` and check `.worktrees/<head.ref>`:
   - Exists → `cd .worktrees/<head.ref>`
   - Missing → `git worktree add .worktrees/<head.ref> <head.ref>` then `cd`
4. Inside a worktree, **`--repo owner/name` is required** (`resolveRepo()` omits only when cwd is repo root)
5. Pass **working cwd (worktree absolute path)** as Bugbot / Security Review `Full Repository Path`

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

Symlink into `~/.claude/skills/` from this repo root (adjust paths to your clone location):

```sh
for s in loophub-repo-add loophub-issue-create loophub-plan-to-issues \
  loophub-pr-review loophub-rebase-conflict loophub-merge-ready; do
  ln -sf "$PWD/skills/$s" "$HOME/.claude/skills/$s"
done
```
