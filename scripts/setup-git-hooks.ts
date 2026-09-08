import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export function setupGitHooks(): void {
  const result = spawnSync("git", ["config", "core.hooksPath", ".githooks"], {
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git config failed with exit code ${result.status}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  setupGitHooks();
}
