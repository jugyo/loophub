import { defineConfig } from "vitest/config";
import { fastTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: fastTestConfig,
});
