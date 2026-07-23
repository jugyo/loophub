import { defineConfig } from "vitest/config";
import { fastTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  // node:sqlite is experimental in Node 22.x; npm scripts pass the required
  // NODE_OPTIONS so Vitest workers inherit them.
  test: fastTestConfig,
});
