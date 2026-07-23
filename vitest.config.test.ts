import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";
import {
  fastTestConfig,
  fullTestConfig,
  gitIntegrationTestFiles,
  integrationTestConfig,
} from "./vitest.shared.ts";

test("test processes do not inherit workflow session attribution", () => {
  expect(process.env.LOOPHUB_SESSION_ID).toBeUndefined();

  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(process.env.LOOPHUB_SESSION_ID ?? 'unset')"],
    { encoding: "utf8", env: { ...process.env } },
  );
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("unset");
});

test("fast and integration configs partition real git tests", () => {
  expect(gitIntegrationTestFiles).toContain("core/git.test.ts");
  expect(gitIntegrationTestFiles).toContain("core/worktrees.test.ts");
  expect(gitIntegrationTestFiles).toContain("cli/workflow-start.test.ts");
  expect(gitIntegrationTestFiles).toContain("worker/runner.test.ts");

  expect(fastTestConfig.exclude).toEqual(gitIntegrationTestFiles);
  expect(integrationTestConfig.include).toEqual(gitIntegrationTestFiles);
  expect(fullTestConfig.include).toContain("core/**/*.test.ts");
  expect(fullTestConfig.exclude).toEqual([]);
});
