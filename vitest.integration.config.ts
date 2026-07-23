import { defineConfig } from "vitest/config";
import { integrationTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: integrationTestConfig,
});
