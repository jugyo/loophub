// Compile-time fixtures for synchronous domain subscribers. Nothing here runs.
import type { SyncSubscriber } from "./domain-events.ts";

export const synchronousSubscriber: SyncSubscriber<"issue.closed"> = () =>
  undefined;

// @ts-expect-error an async subscriber cannot complete inside the command transaction
export const asyncSubscriber: SyncSubscriber<"issue.closed"> = async () => {};
