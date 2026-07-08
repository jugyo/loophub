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

## What this project is

LoopHub is a GitHub-style issue/PR hub over local git repositories, built for AI agents to
run development loops while a human supervises with minimal attention.

## Layout

```
core/    Pure domain library (Node): db, config, store, git, event-hub, links, watcher, service/
cli/     `lh` command — commands/ grouped by noun; imports core directly, no HTTP
web/     `lh-web` process: core + JSON-RPC 2.0 + SSE, plus the SPA
worker/  `lh-worker` resident process: tails shared events, runs per-repo workflow.yml,
         and owns maintenance sweep loops (PR sweep, usage, GitHub merge sync, cost stop, scheduled tasks)
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
npm test            # vitest run (core tests)
npm run test:watch
npm run typecheck   # tsc --noEmit (uses the local typescript; avoids npx)
npm run lint        # biome check (lint + format check; no writes)
npm run format      # biome format --write (apply formatting)
```

Lint/format use [Biome](https://biomejs.dev). Config is `biome.json`; the linter is a
minimal recommended set (type-aware checks stay with `npm run typecheck`).

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

## Data location

State lives in `LOOPHUB_HOME` (default `~/.loophub`), SQLite at `LOOPHUB_DB`
(default `$LOOPHUB_HOME/loophub.db`). The same HOME means the same DB across processes.
