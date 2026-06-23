# AGENTS.md

Guidance for AI agents working in this repository. Keep it short; update it when a
convention changes.

## Conventions

- **Write in English.** Commit messages, code comments, identifiers, and documentation
  are written in English by default. (Conversation with the user may be in Japanese.)
- Match the surrounding code's style, naming, and comment density. Prefer small, focused
  changes over broad rewrites.
- No build step during development — TypeScript runs directly via `tsx`.

## What this project is

LoopHub is a GitHub-style issue/PR hub over local git repositories, built for AI agents to
run development loops while a human supervises with minimal attention.

## Layout

```
core/   Pure domain library (Node): db, config, store, git, event-hub, links, watcher
cli/    `lh` command — imports core directly, no HTTP
web/    `lh-web` process: core + JSON-RPC 2.0 + SSE, plus the SPA
```

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
