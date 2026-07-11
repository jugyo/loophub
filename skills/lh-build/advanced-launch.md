Reference for `lh-build/SKILL.md` § 2 (Worktree & session) — the two branches below are rare; most
`lh-build` runs never reach either.

## Manual launch (not via `lh build`)

Only if you arrived here **without** `lh build` (ad-hoc, or a host that doesn't use the launcher): set up
the worktree and the linked draft PR yourself first, then continue. Opening the linked draft PR records
the session through the PR's session links; there is no separate assign step.

```sh
# `lh build` derives the branch/worktree name from the PR number (`loophub/pr-<m>`), which is not
# known until the PR row exists — a manual launch can't reproduce that, so pick a branch name
# yourself (any name works; `--head` below just has to match it).
BASE="<default-branch>"
git worktree add ~/.loophub/worktrees/<owner>/<repo>/<branch> -b <branch> "$BASE"
cd ~/.loophub/worktrees/<owner>/<repo>/<branch>
SID="$(uuidgen)"
lh session register --id "$SID" --agent lh-build --session "$SID" --runtime claude-code --kind dev
# Open the linked draft PR. `--session-id "$SID"` links the session to the PR, which is the basis for
# `lh resume` / retro. The soft open-PR check makes this the point at which the issue is "taken": a
# second open PR for the same issue is refused (422).
lh pr create --repo <repo> --head <branch> --base "$BASE" --title "..." --issue <n> --draft --session-id "$SID"
```

## Parallel LoopHub server (only when developing LoopHub itself)

This section applies only when the repo under development **is LoopHub itself** (this codebase) and
your change touches `web/server` — `lh-web` is LoopHub's own server binary and has no equivalent in
other registered repos, so skip this entirely otherwise.

The CLI uses production `:8730` by default. **Never stop `:8730`.** If your change touches the server
itself and you need to exercise the new code, run a second server on a free port and point the CLI at it:

```sh
lh-web --port 8731 &
LOOPHUB_URL=http://localhost:8731 lh issue view <n> --repo <repo>
```

| Variable | Purpose |
|----------|---------|
| `LOOPHUB_PORT` | Server listen port (default 8730) |
| `LOOPHUB_URL` | CLI API target (set explicitly when running in parallel) |

`LOOPHUB_HOME` (default `~/.loophub`) is shared across ports, so the production UI (8730) still shows the
data; new API behavior exists only on the new server code. The existing `url` in `config.json` is read
first, so set `LOOPHUB_URL` explicitly when running in parallel.
