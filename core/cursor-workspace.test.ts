import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ensureCursorWorkspaceTrusted } from "./cursor-workspace.ts";
import { encodeCursorProjectCwd } from "./session-usage.ts";

test("ensureCursorWorkspaceTrusted writes Cursor's marker for the exact workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "lh-cursor-trust-"));
  const workspace = join(root, "workspace");
  const projects = join(root, "projects");
  try {
    mkdirSync(workspace);
    const canonicalWorkspace = realpathSync(workspace);
    const marker = ensureCursorWorkspaceTrusted(workspace, projects);
    expect(marker).toBe(
      join(
        projects,
        encodeCursorProjectCwd(canonicalWorkspace),
        ".workspace-trusted",
      ),
    );
    expect(JSON.parse(readFileSync(marker, "utf8"))).toMatchObject({
      workspacePath: canonicalWorkspace,
      trustMethod: "cli-flag",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
