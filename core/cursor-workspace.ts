import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  defaultCursorProjectsDir,
  encodeCursorProjectCwd,
} from "./session-usage.ts";

// Cursor's interactive CLI has no workspace-trust bypass flag. Workflow launches are explicitly
// unattended and already opt into command approval with --force, so establish trust for that one
// concrete worktree before Herdr starts the agent and delivers its prompt.
export function ensureCursorWorkspaceTrusted(
  cwd: string,
  projectsDir = defaultCursorProjectsDir(),
): string {
  const workspacePath = realpathSync(cwd);
  const projectDir = join(projectsDir, encodeCursorProjectCwd(workspacePath));
  const marker = join(projectDir, ".workspace-trusted");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    marker,
    `${JSON.stringify(
      {
        trustedAt: new Date().toISOString(),
        workspacePath,
        trustMethod: "cli-flag",
      },
      null,
      2,
    )}\n`,
  );
  return marker;
}
