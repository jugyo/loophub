# AGENTS.md

Guidance for AI agents working in this repository. Keep it short; update it when a
convention changes.

## Conventions

- **Write in English.** Commit messages, code comments, identifiers, and documentation
  are written in English by default. (Conversation with the user may be in Japanese.)
- Match the surrounding code's style, naming, and comment density. Prefer small, focused
  changes over broad rewrites.
- Current Web UI work primarily targets desktop environments. Unless a requirement
  explicitly asks for it, do not add mobile-only layouts or responsive behavior to an
  unrelated change; treat mobile support as separate, intentional scope.
- No build step during development — TypeScript runs directly via `tsx`.

## Design principles

- Choose the simplest correct solution. Do not add cleanup, retries, polling, or state
  machines for non-fatal failures that a human can recover from.
- Prefer visible errors to automatic recovery. Preserve the existing non-zero exit → RPC
  error → UI path so operators can notice failures and decide how to respond.
- Keep Web-to-CLI RPC calls fire-and-forget. A handler must not wait for long-running
  subprocess work such as agent boot; expose progress asynchronously through the database
  and events instead.
- Keep data-selection semantics in `core`; Web should request the desired result set rather
  than reconstruct it from partial responses.
- Before answering review feedback with another defensive mechanism, apply these principles.
  For plausible but human-recoverable failures, explicitly accepting the risk can be correct.
- Background reading that informs how we design agent loops lives in
  [`docs/canon/`](docs/canon/README.md) — summaries of external sources, treated as design
  north stars rather than specs.

## What this project is

LoopHub is a GitHub-style issue/PR hub over local git repositories, built for AI agents to
run development loops while a human supervises with minimal attention.

## Glossary

- **Issue**: the problem or desired outcome, including its acceptance criteria. An issue has at
  most one open linked PR; after that PR is closed, a later PR may be linked for another try.
- **Pull request (PR)**: a reviewable implementation proposal linked to an issue. It owns the
  head/base refs, draft and review state, and merge outcome; it is the unit that is delivered.
- **Session**: one recorded agent-runtime invocation. Sessions can be linked to issues or PRs;
  multiple sessions may contribute to one PR, while its primary development session is the usage
  attribution and retrospective anchor. LoopHub does not resume coding-agent sessions.
- **Workspace**: a local Git branch used as an integration target for a group of issues and
  their PRs. Its registry row only makes the branch visible to LoopHub; unlike a worktree, a
  workspace has no dedicated checkout.
- **Workflow / workflow run**: a workflow is a reusable Execute/Verify definition. Execute owns
  implementation planning and reflection; Verify independently evaluates the result. A workflow
  run is one persisted execution for a specific issue and PR, tracking step state, sessions, and
  artifacts. A run may prepare or reuse a PR, but is not itself a PR or session.
  Starting work on an issue uses `lh workflow start` (Web: **Start workflow**). The
  event-triggered `.loophub/workflow.yml` worker configuration is separate repository automation.
  (`lh build` was removed; do not present it as a current procedure.)
- **Worktree**: a Git linked checkout dedicated to a PR. Convention: branch
  `loophub/pr-<m>` at `$LOOPHUB_HOME/worktrees/<owner>/<repo>/pr-<m>`, keyed by PR number.
  Provisioned by shared helpers (`cli/dev.ts` / `dev.openPr` / worktree provision) when a
  Workflow (or other launcher) starts work.

See [worktree lifecycle](docs/worktree.ja.md),
[historical parallel-attempt design](docs/parallel-issue-attempts-design.ja.md), and
[workflow design](docs/workflow.ja.md) for details.

## Layout

```
core/    Pure domain library (Node): db, config, store, git, events, links, watcher, service/
cli/     `lh` command — commands/ grouped by noun; imports core directly, no HTTP
web/     `lh-web` process: core + JSON-RPC 2.0, plus the SPA
worker/  `lh-worker` resident process: tails shared events, runs per-repo workflow.yml,
         and owns maintenance sweep loops (PR sweep, usage, GitHub merge sync, cost stop)
```

### Responsibility split (core vs cli)

Keep `cli/` thin: each `cli/commands/<group>.ts` parses flags, calls a procedure re-exported from
`core/service.ts` (a barrel over the domain modules under `core/service/`, e.g. `service/pulls.ts`,
`service/dev.ts`, `service/worktrees.ts`), and presents the result (text/JSON, prompts, exit codes).
**Domain logic — orchestration across git + the DB, state resolution, destructive operations —
belongs in `core`**, where it is reusable (CLI now, JSON-RPC/web later) and unit-testable without
spawning the CLI. Pure, side-effect-free decisioning (parsing, guards, classification) goes in its
own `core` module (e.g. `core/worktree-prune.ts`) that the relevant `service/*.ts` module composes.
When a handler starts looping over git/DB calls and branching on the results, that logic is a sign
it should move into a `service/*.ts` procedure (see `worktrees.plan` / `worktrees.remove` for the
`lh worktree prune` command).

### Wire types (core vs web)

`core/serialize.ts` is the single source of truth for wire shapes. `web/src/api/types.ts` derives
its types from `core/serialize.ts` via type-only imports instead of re-declaring them — do not
hand-write a wire type in `web/` that duplicates one already produced by a core serializer.

Keep `core/serialize.ts` synchronous and free of `node:fs` / `core/git.ts`: every function there
converts rows to wire objects, so it is unit-testable without a git repo. Serializers whose values
come from live git or worktree state (`pullJSON`, `issueListItemJSON`, `issueDetailJSON`) live in
`core/serialize-status.ts` and import their wire types back from `core/serialize.ts`.

## Runtime requirements

- **Node.js >= 22.12.0.**
- Persistence uses **`node:sqlite`** (`DatabaseSync`), which is experimental on Node 22.x
  and requires `--experimental-sqlite`. The npm scripts pass it (plus a warning suppressor)
  via `NODE_OPTIONS='--experimental-sqlite --disable-warning=ExperimentalWarning'`. Any new
  entry point or spawned subprocess that touches the DB must carry the same flag.
- `core/db.ts` loads `node:sqlite` through `createRequire` so bundler-based transformers
  (Vite/vitest) don't try to resolve the experimental specifier — keep it that way.

## Commands

```sh
npm install
npm test                 # fast tests (excludes real-git integration tests)
npm run test:integration # real-git repository/worktree integration tests
npm run test:full        # full root test suite
npm run test:watch       # watch fast tests
npm run typecheck        # tsc --noEmit (uses the local typescript; avoids npx)
npm run lint             # biome check (lint + format check; no writes)
npm run format           # biome format --write (apply formatting)
```

Lint/format use [Biome](https://biomejs.dev). Config is `biome.json`; the linter is a
minimal recommended set (type-aware checks stay with `npm run typecheck`).

## Attached documents

An issue or PR body can link a document attachment (`[findings.md](/attachments/<sha256>)`),
typically a hand-off from an earlier investigation. Read one with `lh attachment get
<sha256|url>` — text goes to stdout, `--json` reports its metadata and stored path. Attach
one with `lh attachment add --file <path>` and put the printed markdown in the body.

## Tests

- Vitest, co-located as `<module>.test.ts` next to the source under each layer.
- `core/db.ts` opens the DB at import time using `LOOPHUB_HOME` / `LOOPHUB_DB`. Tests that
  need an isolated DB must set those env vars **before** importing any core module, then
  use a dynamic import:

  ```ts
  process.env.LOOPHUB_HOME = mkdtempSync(join(tmpdir(), "lh-"));
  process.env.LOOPHUB_DB = join(process.env.LOOPHUB_HOME, "test.db");
  let S: typeof import("./store.ts");
  beforeAll(async () => { S = await import("./store.ts"); });
  ```

- Keep tests deterministic and self-contained: create a temp git repo / HOME, assert, and
  clean up in `afterAll`.

## Visual evidence

For UI or visual changes, do not mark screenshot evidence as N/A only because the in-app browser
or Chrome is unavailable. First check whether Playwright MCP is available. When it is, capture the
screenshot with Playwright MCP, save it under
`${LOOPHUB_HOME:-$HOME/.loophub}/evidence/<owner>/<repo>/issue-<n>/`, upload it with
`lh attachment add --file <path>`, and embed the printed attachment markdown in the PR Evidence
section. Use screenshot N/A only when Playwright MCP is unavailable or unsuitable and every other
practical capture path is blocked; record the alternative verification and the specific reason.

Clean up after evidence capture. Stop or close anything you started in the worktree to take a
screenshot — an `lh-web` you launched, a browser tab you opened — before the session ends; a server
left running keeps consuming CPU and a stale tab keeps polling it. There is no standalone Vite dev
server; serve the worktree's UI from its own `lh-web` on a non-prod port and a separate
`LOOPHUB_HOME` (`LOOPHUB_HOME=$(mktemp -d) npm run lh-web -- --port 8731`), and shut it down when
done. If the sandbox blocks `kill` and a process leaks anyway, say so in the PR so a human can stop
it rather than leaving it running silently.

## Data location

State lives in `LOOPHUB_HOME` (default `~/.loophub`), SQLite at `LOOPHUB_DB`
(default `$LOOPHUB_HOME/loophub.db`). The same HOME means the same DB across processes.
