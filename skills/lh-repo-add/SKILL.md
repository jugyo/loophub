---
name: lh-repo-add
description: >-
  Register a local git repository with LoopHub via lh repo add, then STOP. Use when the user runs
  /lh-repo-add, asks to add/register a repo in LoopHub, リポジトリ追加, or onboard a local
  checkout — NOT for issue creation, implementation, or repo update/archive/remove.
---

# LoopHub repo add

Register a **local git repository** with LoopHub so issues and PRs can be tracked. **Stop after
reporting successful registration. Do not implement or chain to other skills.**

## Scope boundary (read first)

**This skill ends when the repo is registered and verified.** Adding a repo does **not** include
creating issues, starting implementation, or changing repo metadata.

| Do | Do not |
|----|--------|
| Validate path, run `lh repo add`, verify with `lh repo list`, report result | Start implementation or create issues |
| Read-only checks (`test -d`, `git -C … rev-parse`) | Edit source in the target repo |
| **Suggest** follow-on skills in text | **Continue** to follow-on skills yourself |

### Done when

Stop **immediately** when all of the following are true:

- [ ] `lh repo add` succeeded (or user chose to abort after a clear error)
- [ ] Registration confirmed via `lh repo list`
- [ ] `full_name` and `local_path` reported to the user

### Common mistakes

```text
❌ After adding a repo, auto-create a ready-to-build issue
❌ Run lh repo update / archive / remove without explicit user request
❌ Assume lh serve is running — check or tell the user to start it first
✅ Add repo → verify list → report → stop
```

## Invocation

`/lh-repo-add` — register from conversation context (path and optional `owner/name`).

Optional arguments the user may supply:

```text
/lh-repo-add /abs/path/to/checkout
/lh-repo-add /abs/path --name owner/repo
```

Do not use the `loop-` prefix — it collides with Cursor's built-in `/loop` (scheduled runs).

## LoopHub

- Server: default `http://localhost:8730` (`~/.loophub/config.json`) — **`lh serve` must be running**
- **CLI**: `lh` or `bun run <repo>/src/cli.ts`
- `lh repo add` does not require `--repo` (registers globally under `LOOPHUB_HOME`)

| Action | CLI |
|--------|-----|
| Register | `lh repo add <path> [--name owner/repo]` |
| Verify | `lh repo list` |
| Inspect one | `lh repo list --json` (filter by `full_name`) |

### Web URL (for reporting)

After registration, the repo appears in the LoopHub UI:

```text
{baseUrl}/r/{owner}/{repo}
```

- **baseUrl**: `url` in `~/.loophub/config.json` → `http://localhost:${LOOPHUB_PORT:-8730}`

Example: `http://localhost:8730/r/jugyo/my-project`

## Procedure

### 1. Gather inputs

From the conversation, determine:

- **Path** — absolute or relative directory of the local checkout (default: ask if ambiguous)
- **Name** (optional) — `owner/repo` slug (see naming below)

If the user only named a project without a path, ask for the absolute path before proceeding.

Normalize the path to an absolute directory before any duplicate check or API call:

```sh
PATH_TO="$(cd "$PATH_TO" && pwd -P)"
```

### 2. Pre-flight checks (local)

Run before calling the API:

```sh
PATH_TO="<absolute-path>"
test -d "$PATH_TO" || { echo "directory missing"; exit 1; }
git -C "$PATH_TO" rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git repo"; exit 1; }
```

| Check | Failure | Action |
|-------|---------|--------|
| Directory exists | `No such file or directory` | Stop; ask user to fix path or clone first |
| Git repository | `not a git repository` | Stop; `git init` or point to the repo root |
| LoopHub server | connection refused on `lh repo add` | Tell user to run `lh serve` |

Optional duplicate hint (does not replace API validation):

```sh
lh repo list
```

If the same `local_path` or intended `owner/repo` is already listed, show the existing entry and ask
whether to abort (re-register requires `lh repo remove` — out of scope unless user explicitly asks).

### 3. Choose `owner/repo` name

CLI:

```sh
lh repo add <path> [--name owner/repo]
```

| Input | Result |
|-------|--------|
| `--name owner/repo` | Registers as `owner/repo` |
| Omitted | Defaults to `me/<basename-of-path>` (last path segment) |

Rules:

- Use **`owner/name`** with exactly one slash (e.g. `jugyo/local-github`, `bringout/recall-ai-cli`)
- Prefer a stable owner prefix the team recognizes (`jugyo/`, `bringout/`, `me/` for personal sandboxes)
- Name is the LoopHub identity — it need not match the GitHub remote URL

### 4. Register

When the user supplied an explicit name:

```sh
lh repo add "$PATH_TO" --name <owner>/<repo>
```

When no name was given (CLI default `me/<basename-of-path>`):

```sh
lh repo add "$PATH_TO"
```

Do not pass the literal string `owner/repo` — substitute the chosen slug from step 3.

On success the CLI prints:

```text
added owner/repo  (/absolute/path)
```

### 5. Verify

```sh
lh repo list
```

Confirm the new row shows the expected `full_name` and `local_path`.

### 6. Report (stop here)

1. Report `full_name`, `local_path`, and default branch if shown
2. Link the **repo UI URL** (Web URL format above) as a markdown link
3. **Stop** — skill work is complete

Optional guidance only (do not auto-run):

```text
To file work: /lh-issue-create
```

## Error handling

| API / CLI message | Cause | Remedy |
|-------------------|-------|--------|
| `path does not exist: …` | Bad path | Fix path; re-run pre-flight |
| `not a git repository: …` | Not a repo root | `cd` to git root or initialize git |
| `already registered: owner/repo` | Name taken | Pick another `--name` or use existing entry |
| `path and name are required` | Missing args | Pass path; add `--name` if needed |
| Connection error | Server down | Start `lh serve`; retry |

Do not retry blindly on `already registered` — confirm intent with the user first.

## Out of scope (this skill)

- `lh repo update`, `lh repo archive`, `lh repo unarchive`, `lh repo remove`
- UI-based repo registration
- Cloning or creating git repositories
- Symlinking skills (`skills/README.md` Install section — human one-time setup)

## Prohibited

- Do not start implementation or `lh-issue-create` after registration
- Do not modify the target repository's source code
- Do not merge PRs or assign issues as part of repo registration
