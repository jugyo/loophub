# LoopHub Web UI

React SPA (Vite + TypeScript + Tailwind) for LoopHub. `lh-web` builds the SPA at startup and
serves the resulting `dist/` itself, so a single process serves the API (`/rpc`) and the UI on one
port — no separate dev server.

> Note: the components use a shadcn-style design system (Tailwind + `cn`/`cva` tokens,
> `components/ui/`) but are not yet a full shadcn install (no Radix / `components.json`).
> A dedicated shadcn migration is tracked separately.

## Stack

- **Vite + React + TypeScript**
- **Tailwind CSS** + shadcn-style design tokens
- **TanStack Query** — server state
- **TanStack Router** — routing (code-based route tree in `src/router.tsx`)

## Dev (single command)

From the repo root:

```sh
npm install
npm --prefix web install # also run by the root postinstall; explicit so it works with ignore-scripts=true
npm run lh-web          # http://localhost:8730 — API + UI, one process
```

Open http://localhost:8730. Startup runs `vite build` (a few seconds) and everything after that is
static file serving: there is no HMR client and no dev WebSocket in the page, so editing a source
file never moves a screen you are working in. **Restart `lh-web` to pick up a source change.**

There is no standalone Vite dev server or API proxy. The SPA is always served same-origin, same
process, by its own `lh-web`, and `src/api/client.ts` always uses a same-origin base — there is no
way to point the frontend at a different backend.

### UI dev / verification in a worktree

Run the worktree's *own* `lh-web`, isolated from your prod instance, on a non-prod port and a separate
`LOOPHUB_HOME` so it never touches the prod DB or port:

```sh
LOOPHUB_HOME=$(mktemp -d) npm run lh-web -- --port 8731   # inside the worktree
```

Open http://localhost:8731 to develop or capture evidence against that worktree's code, and stop it
when done.

## Scripts (in `web/`)

| Script | Purpose |
|--------|---------|
| `npm run build` | Type-check + production build to `dist/` |
| `npm run test` | Vitest |

`lh-web` runs the same production build itself at startup and then serves `dist/` through its
static handler; `npm run build` is the same thing plus a type-check, on demand.

## API client

- `src/api/client.ts` — **JSON-RPC 2.0** client (single `POST /rpc`). Written against the
  language-neutral contract (`docs/rpc-contract.json`); never imports core types.
- `src/api/types.ts` — hand-written wire types matching the contract result shapes.

## JSON-RPC transport limits

`POST /rpc` enforces three explicit transport limits:

- Request bodies are limited to 1 MiB. After a request crosses the limit, the server stops retaining
  chunks, drains the rest of the stream, and returns HTTP 413 with JSON-RPC code `-32002`.
- Batches are limited to 100 elements and are rejected before any element is dispatched with HTTP 200
  and `-32600 Invalid Request`.
- Serialized responses are limited to 10 MiB. The bounded serializer retains at most the limit and
  replaces an oversized result with HTTP 200 and a small `-32001 Response too large` JSON-RPC error.

These limits leave headroom above existing SPA defaults. An issue-list page requests 21 records (20
visible rows plus one lookahead record), and each event poll requests at most 100 events. The `lh` CLI
does not use this transport; it calls `core/service` directly.

See the [transport limit design note](../docs/json-rpc-transport-limits.md) for the bounded response
serializer, remaining allocation boundary, and streaming decision.

## Live updates

`src/lib/use-loophub-events.ts` (`useLoopHubEvents`) polls `events/list` with an id cursor and
calls `queryClient.invalidateQueries()` for every returned event. It uses a 1.5-second cadence
while visible, 5 seconds while hidden, and immediately drains full 100-event pages. The event-type
→ query-key mapping lives in `src/lib/event-keys.ts`.

## Sessions

`src/lib/session.ts` manages the agent `session_id` in `sessionStorage`, plus the last
seen persisted event id used to resume polling.
