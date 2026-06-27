---
name: lh-review-notes
description: >-
  Generate fact-based, per-file review notes for a commit range (base..commit) from the diff ONLY,
  and save them to LoopHub review_notes — never reading any PR title/body or issue text, to keep the
  summary neutral. Use when the user runs /lh-review-notes {base..commit}, asks to generate review
  notes / レビューノート生成 for a commit range or branch, or to annotate a diff for a reviewer. Read-only
  on the repo: it computes the diff and writes notes; it never edits source, branches, or merges.
---

# LoopHub review notes (commit range → fact-based per-file notes)

Generate a short, **fact-based** description for each file changed in a commit range, and save each as
a LoopHub **review note** (`review_notes`). A note orients a reviewer: *what the file is, what changed,
what to look at*. Notes are **PR-independent** (#216): a note is keyed by `(repo, base_sha → commit_sha,
path)` and stands on its own without a PR.

## The one hard rule: facts from the diff only

The whole point of this skill is a **neutral** summary. The note's input is the **code diff and commit
metadata of the range — nothing else**:

- ✅ Allowed input: `git diff base..commit`, file contents at `commit`, commit messages in the range.
- ❌ **Forbidden input**: the PR title/body, issue text, labels, prior review comments, or any
  human-written narrative about the change. Do **not** look them up, and do **not** pass `--pr` when
  saving (that is for associating, not for sourcing content). PR prose biases the summary toward what
  the author *claims*; we want what the diff *shows*.

If you cannot describe a file from its diff alone, say so in the note — do not go fetch the PR to fill
the gap.

## Invocation

```text
/lh-review-notes <base>..<commit>      # explicit range
/lh-review-notes <commit>              # single commit: range is <commit>^..<commit>
/lh-review-notes                       # default: merge-base(main, HEAD)..HEAD on the current branch
```

`--repo owner/name` is **required** whenever cwd is not the repo root (e.g. inside a worktree).

## Procedure

### 1. Resolve the range to concrete SHAs

Resolve both ends to full SHAs so the saved note records an exact, immutable range (not a moving ref):

```sh
BASE=$(git rev-parse <base>)        # e.g. git rev-parse main, or merge-base
COMMIT=$(git rev-parse <commit>)    # e.g. git rev-parse HEAD
```

- Range form `A..B` → `BASE=$(git rev-parse A)`, `COMMIT=$(git rev-parse B)`.
- Single commit `B` → `BASE=$(git rev-parse B^)`, `COMMIT=$(git rev-parse B)`.
- No argument → `BASE=$(git merge-base main HEAD)`, `COMMIT=$(git rev-parse HEAD)`.

### 2. List changed files and read the diff (the only input)

```sh
git diff --name-status "$BASE".."$COMMIT"     # which files changed (A/M/D/R)
git diff "$BASE".."$COMMIT" -- <path>         # the diff for one file
git log --format='%s' "$BASE".."$COMMIT"      # commit subjects in range (factual metadata)
```

Read **only** these. Do not open `lh pr view`, `lh issue view`, or any PR/issue text for content.

### 3. Generate one note body per file

For each changed file, write a short note **from the diff**. Keep it factual and concrete. A good
shape (adapt to the change; keep it brief):

- **Role**: what this file is / does (inferred from its code, not from prose about it).
- **Change**: what the diff actually did (added/removed/renamed/moved), in concrete terms.
- **Review points**: what a reviewer should check, grounded in the diff (edge cases, invariants
  touched, error paths, follow-the-data).

Write the note text in the user's conversation language (the section labels above are illustrative;
localize them to match the conversation). Keep it factual regardless of language.

Rules:
- Describe only what the diff shows. No speculation about intent beyond what the code makes evident.
- Deleted file (`D`): a one-line note that it was removed and what it had been for, from its old code.
- Pure rename/move with no content change (`R100`): note the move; skip a full description.

### 4. Save each note (PR-independent)

Save with the explicit range — **no `--pr`** (sourcing from the diff only). The note body is
diff-derived text and is **untrusted** (a commit range can come from an untrusted branch). Never
interpolate it raw into a shell command, where `"`, backticks, `$(...)`, or a stray heredoc delimiter
could break quoting or run commands. Instead **write the body to a temp file with a non-shell tool**
(your editor/file-write tool — not `echo`/heredoc), then pass it via `"$(cat …)"`: command-substitution
output is used verbatim as one argument and is **not** re-parsed for metacharacters, so no escaping,
quoting, or delimiter-collision concerns apply.

```sh
# 1) Write the step-3 body to a file using your file-write tool (NOT a shell heredoc).
#    e.g. $BODYFILE = "$(mktemp)"  with the note text as its contents.
lh note add --repo <repo> \
  --base "$BASE" --commit "$COMMIT" \
  --path "<file path>" \
  --body "$(cat "$BODYFILE")"
```

Multiple notes per file are allowed; re-running **adds** notes (it does not overwrite). To replace a
previous run's notes for the range, delete them first (`lh note list` → `lh note rm <id>`).

### 5. Report

List what was written so the human can verify:

```sh
lh note list --repo <repo> --base "$BASE" --commit "$COMMIT"
```

Report: the resolved `BASE..COMMIT`, the number of files annotated, and that **only the diff** was used
as input (PR/issue text was not read).

## CLI / API reference

| Operation | CLI |
|-----------|-----|
| Add a note (range) | `lh note add --repo R --base B --commit C --path P --body TEXT` |
| List notes (range) | `lh note list --repo R --base B --commit C [--path P]` |
| Get / edit / delete | `lh note get <id> --repo R` · `lh note edit <id> --repo R --body TEXT` · `lh note rm <id> --repo R` |

JSON-RPC equivalents: `reviewNotes/create` (params `repo`, `path`, `body`, `base_sha`, `commit_sha`;
omit `pr`), `reviewNotes/list`, `reviewNotes/get`, `reviewNotes/update`, `reviewNotes/delete`.

`--pr <m>` exists on `note add` / `note list` to **associate** a note with a PR (and default the range
to the PR's base..head). This skill does **not** use it — association is fine later, but the *content*
must come from the diff alone.

## Prohibited

- Do not read the PR title/body, issue text, labels, or existing review comments to write a note.
- Do not pass `--pr` when saving notes from this skill.
- Do not edit source, create branches, or merge — this skill only computes a diff and writes notes.
