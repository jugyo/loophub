# LoopHub Web UI

React SPA (Vite + TypeScript + Tailwind) for LoopHub. It runs as a separate process
from the `lh-web` server: in dev, the Vite dev server (:5173) proxies `/rpc` and
`/events` to `lh-web` (:8730); in prod, `lh-web` serves the built assets from `dist/`.

> Note: the components use a shadcn-style design system (Tailwind + `cn`/`cva` tokens,
> `components/ui/`) but are not yet a full shadcn install (no Radix / `components.json`).
> A dedicated shadcn migration is tracked separately.

## Stack

- **Vite + React + TypeScript**
- **Tailwind CSS** + shadcn-style design tokens
- **TanStack Query** — server state
- **TanStack Router** — routing (code-based route tree in `src/router.tsx`)

## Two-process dev

```sh
# terminal 1 — lh-web server (repo root)
npm run lh-web          # :8730 (POST /rpc, GET /events)

# terminal 2 — web UI
cd web
npm install
npm run dev             # http://localhost:5173 (proxies /rpc + /events)
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm run dev` | Vite dev server (:5173) with the `/rpc` + `/events` proxy |
| `npm run build` | Type-check + production build to `dist/` |
| `npm run preview` | Preview the production build (:4173) |
| `npm run test` | Vitest |

## Production-like preview

```sh
# terminal 1 — lh-web (repo root)
npm run lh-web          # :8730

# terminal 2 — web UI preview
cd web
npm run build           # tsc --noEmit + vite build → dist/
npm run preview         # http://localhost:4173
```

`lh-web` can also serve `dist/` directly in production (no Vite); see the repo README.

## API client

- `src/api/client.ts` — **JSON-RPC 2.0** client (single `POST /rpc`). Written against the
  language-neutral contract (`docs/rpc-contract.json`); never imports core types.
- `src/api/types.ts` — hand-written wire types matching the contract result shapes.

## Live updates (SSE)

`src/lib/use-loophub-events.ts` (`useLoopHubEvents`) subscribes to `/events` with
`EventSource`. lh-web sends each event as a `loophub` frame whose data is a JSON-RPC
`events/notify` notification; the hook unwraps it and calls
`queryClient.invalidateQueries()`. The event-type → query-key mapping lives in
`src/lib/event-keys.ts`.

## Sessions

`src/lib/session.ts` manages the agent `session_id` in `sessionStorage`, plus the last
seen SSE event id used to resume the stream.
