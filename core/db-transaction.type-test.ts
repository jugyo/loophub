// Compile-time fixtures for `Db.transaction`. Nothing here runs: the file exists so
// `npm run typecheck` fails if the synchronous-callback guard stops rejecting a shape it must
// reject. Each `@ts-expect-error` inverts the assertion — the build breaks when its line starts to
// compile. `Db` is imported as a type and the instance is declared, so no database is opened.
import type { Db } from "./db.ts";

declare const db: Db;
declare const condition: boolean;

// A synchronous callback compiles, and its own return type flows through unchanged.
export const count: number = db.transaction(() => 1);
export const maybe: string | undefined = db.transaction(() =>
  condition ? "value" : undefined,
);
// A callback that returns nothing — the common store-helper shape — compiles as well.
db.transaction(() => {});

// @ts-expect-error an async callback is not synchronous
db.transaction(async () => {});

// @ts-expect-error a callback returning a Promise is not synchronous
db.transaction(() => Promise.resolve(1));

// @ts-expect-error a PromiseLike member in a union return is not synchronous
db.transaction(() => (condition ? Promise.resolve() : undefined));
