import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["core/**/*.test.ts", "cli/**/*.test.ts", "web/server/**/*.test.ts", "worker/**/*.test.ts"],
    // node:sqlite is experimental in Node 22.x; the flag is passed via NODE_OPTIONS
    // in the `test` npm script so vitest workers inherit it.
  },
});
