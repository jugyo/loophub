<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loophub-logo-dark.svg">
    <img src="docs/assets/loophub-logo.svg" alt="LoopHub" height="40">
  </picture>
</h1>

[![CI](https://github.com/jugyo/loophub/actions/workflows/ci.yml/badge.svg)](https://github.com/jugyo/loophub/actions/workflows/ci.yml)

日本語版: [README.ja.md](./README.ja.md)

**LoopHub is a GitHub-style issue / PR hub for git repositories on your own machine.**
Write an issue, press Start, and a coding agent (Claude Code and others) implements the change in a dedicated git worktree while a separate agent reviews the result independently. You focus on writing issues and deciding whether to merge the PR.

It is not a remote service. Everything runs as local processes against a local SQLite database.

Who it is for:

- You want coding agents to work on several tasks in parallel, but you are tired of jumping between terminal tabs to track progress
- You want to judge agent output as a **diff and a PR**, not as a chat log
- You want an **independent review**, not only the implementing agent's self-report

![LoopHub issue list. On #1 a workflow is running with Execute → Verify → Done progress and a link to PR #4](docs/screenshots/issues-overview.png)

## How it works

1. **Create an issue.**
2. **Start a workflow.** LoopHub provisions a PR and its dedicated worktree and launches agents in terminal panes.
3. **Execute (implement)** — An agent reads the issue, implements, runs tests, commits, and updates the PR.
4. **Verify (review)** — A separate agent session returns pass or request changes. Request changes sends work back to Execute.
5. **A human merges.**

While work is in progress, the browser UI shows status across all repositories, and you can jump into an agent's pane to give direct instructions when needed.

Terms:

- **Issue** — the problem to solve and its acceptance criteria.
- **Pull request (PR)** — an implementation proposal linked to an issue. It owns head/base refs, draft/review state, and merge outcome.
- **Worktree** — a PR-dedicated git linked checkout (branch `loophub/pr-<n>`). Work does not step on other worktrees.
- **Workflow run** — one Execute / Verify execution for a specific issue and PR.

## Prerequisites

LoopHub itself is build-free TypeScript, but **several external CLIs must be on your PATH**.
In particular, **without herdr you cannot start a workflow** — the core feature will not work.

| Tool | Role | How to get it |
|---|---|---|
| **Node.js >= 22.12.0** | Run LoopHub (CLI / Web / worker) | [nodejs.org](https://nodejs.org) |
| **git** | Repo registration, worktrees, branches, diffs, merges | Your OS package manager or installer |
| **herdr** | Terminal multiplexer that launches and places agents. `lh workflow start` calls it directly | `brew install herdr` — [herdr.dev](https://herdr.dev) |
| **A coding-agent CLI (at least one)** | The process that writes code | e.g. `claude`, `codex`, `grok`, `cursor-agent` |

## Quick start

From clone to opening the UI.

**1. Get LoopHub and install dependencies**

```sh
git clone <this-repo> loophub
cd loophub
npm install          # also installs web/ deps via postinstall
```

**2. Put `lh` on your PATH**

```sh
npm link
lh info                           # OK if baseUrl / home / dbPath print
```

**3. Register the repository you want to manage**

```sh
lh repo add ~/work/my-project --name me/my-project
```

**4. Open the UI**

```sh
npm run serve        # http://localhost:8730 — lh-web + lh-worker
```

Create issues and start workflows from the UI. Process variants, CLI commands, and data paths are under [Processes, CLI, and data](#processes-cli-and-data).

## Security assumptions

LoopHub is a **local tool for one person on one machine**. It has no authentication or authorization.
`/rpc` on `lh-web` can run shell commands and start agents, so
**anyone who can reach `/rpc` can run arbitrary code on your machine**.
The default bind address is therefore loopback only (`127.0.0.1`).

> **Warning**: Setting `LOOPHUB_HOST` to a non-loopback address (for example `0.0.0.0`) lets anyone on the same network run arbitrary code on your machine with no auth. Placing it behind a reverse proxy or running it on a public host is not a supported setup.

## Processes, CLI, and data

### Processes

```sh
npm run serve                   # lh-web + lh-worker together
npm run serve:debug             # same, with the component debug UI enabled
npm run lh-web                  # http://localhost:8730 — API + UI + HMR in one process
npm run lh-worker               # tail events and run per-repo automation
```

Output is prefixed with `[web]` / `[worker]`. If either process under `serve` exits, the other stops and `serve` exits. `Ctrl-C` stops both.
`serve:debug` starts the same two processes and only passes `--debug` to `lh-web`.

### CLI

`lh` calls `core/service` directly — no server process is required (it reads and writes the same SQLite under `LOOPHUB_HOME`). Point at another checkout with `LOOPHUB_ROOT=/path/to/loophub lh ...`. Run `lh` with no arguments for the full command list.

```sh
lh issue create --title "do the thing"
lh issue create --title "stacked change" --workspace integration/stack
lh workflow start 1 --workflow default --herdr
lh pr create --head feature-x --base main --title "impl" --issue 5
lh pr merge 3 --method squash
```

### Where data lives

State lives under `LOOPHUB_HOME` (default `~/.loophub`). SQLite is at `LOOPHUB_DB`
(default `$LOOPHUB_HOME/loophub.db`). Processes that share the same HOME share the same DB.
Worktrees are created at `$LOOPHUB_HOME/worktrees/<owner>/<repo>/pr-<n>`.

## Development

For conventions, layout, test commands, and design principles, see [`AGENTS.md`](./AGENTS.md)
(`CLAUDE.md` is a symlink to it).

CI on PRs and pushes to main runs `typecheck` / `lint` / `test` / `test:integration`
([CI workflow](.github/workflows/ci.yml)).

## License

[MIT License](./LICENSE)
