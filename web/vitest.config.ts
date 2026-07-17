import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  test: {
    environment: "happy-dom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    // These are CPU-bound happy-dom render tests. Left uncapped, Vitest spawns one
    // worker per core minus one, saturating every core at once and spiking CPU on
    // larger machines. Cap the pool to match the core suite (see vitest.config.ts).
    minWorkers: 1,
    maxWorkers: 4,
  },
});
