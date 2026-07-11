# LoopHub Web UI

React SPA (Vite + TypeScript + Tailwind) for LoopHub. `lh-web` embeds Vite in middleware
mode, so a single process serves the API (`/rpc`) and the SPA (with HMR) on one
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
npm install             # also installs web deps (root postinstall)
npm run lh-web          # http://localhost:8730 — API + UI + HMR, one process
```

Open http://localhost:8730. Editing files under `web/src` hot-reloads the browser.
`lh-web` mounts Vite (middleware mode) for everything except `/rpc` and `/attachments` routes.

### Standalone Vite (optional)

For frontend-only work you can still run Vite on its own; it proxies `/rpc` and `/attachments` routes
to a separately running `lh-web`:

```sh
npm run lh-web          # repo root → :8730 (API)
cd web && npm run dev   # :5173 (proxies to :8730)
```

## Scripts (in `web/`)

| Script | Purpose |
|--------|---------|
| `npm run dev` | Standalone Vite dev server (:5173) with API proxies |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Preview the production build (:4173) |
| `npm run test` | Vitest |

`lh-web`'s default static handler can also serve a built `dist/` (Vite-free) as a fallback;
the embedded Vite path is the primary dev flow.

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

These limits leave headroom above existing SPA defaults. An issue-list page requests 101 records (100
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
