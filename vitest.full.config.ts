import { defineConfig } from "vitest/config";
import { fullTestConfig } from "./vitest.shared.ts";

export default defineConfig({
  test: fullTestConfig,
});
