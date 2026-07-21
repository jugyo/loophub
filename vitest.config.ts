import { defineConfig } from "vitest/config";

// Tests create isolated databases that do not contain the invoking workflow's
// session. Individual tests that exercise attribution set this env explicitly.
delete process.env.LOOPHUB_SESSION_ID;

export default defineConfig({
  test: {
    include: [
      "vitest.config.test.ts",
      "scripts/**/*.test.ts",
      "core/**/*.test.ts",
      "cli/**/*.test.ts",
      "web/server/**/*.test.ts",
      "worker/**/*.test.ts",
    ],
    // The include list is exhaustive; clear the default config-file exclusion
    // so the co-located vitest.config.test.ts contract runs with the suite.
    exclude: [],
    // Many integration tests launch git/CLI subprocesses and open isolated SQLite databases.
    // Capping workers avoids oversubscribing those shared host resources on larger machines,
    // which can otherwise push healthy tests past Vitest's default 5s timeout.
    minWorkers: 1,
    maxWorkers: 4,
    // node:sqlite is experimental in Node 22.x; the flag is passed via NODE_OPTIONS
    // in the `test` npm script so vitest workers inherit it.
  },
});
