// Query key factories for TanStack Query, shared by query hooks and the SSE
// invalidation map (../lib/event-keys.ts). Re-exported here so screens import
// keys from a single `queries/` entrypoint as later UI issues land.

export { queryKeys } from "@/lib/event-keys";
