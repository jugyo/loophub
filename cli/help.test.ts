import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
let home: string;

function lh(args: string[]) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "lh-help-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("--help", () => {
  test("works after flags and positional arguments without running the command", () => {
    const result = lh([
      "issue",
      "create",
      "ignored-position",
      "--title",
      "must not be created",
      "--help",
    ]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("lh issue create — Create an issue.");
    expect(existsSync(join(home, "loophub.db"))).toBe(false);
  });

  test("documents issue creation options and structured acceptance criteria without touching the DB", () => {
    const result = lh(["issue", "create", "--help"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("--title <text>");
    expect(result.stdout).toContain("--body <text>");
    expect(result.stdout).toContain("--label <name,...>");
    expect(result.stdout).toContain("--ac <text>");
    expect(result.stdout).toContain("--workspace <name>");
    expect(result.stdout).toContain("--target-branch <ref>");
    expect(result.stdout).toContain("--repo <owner/name>");
    expect(result.stdout).toContain("--session-id <uuid>");
    expect(result.stdout).toContain("--json");
    expect(result.stdout).toContain("--help");
    expect(result.stdout).toContain(
      "saved as one structured acceptance_criteria entry, in command-line order",
    );
    expect(result.stdout).toContain("Keep acceptance criteria out of --body");
    expect(result.stdout).toContain(
      'do not add an\n  "Acceptance criteria" heading or duplicate checklist there',
    );
    expect(result.stdout).toContain(
      '--ac "Exports retain input order" --ac "Repeated exports are byte-identical"',
    );
    expect(result.stdout).not.toContain("## Acceptance criteria");
    expect(existsSync(join(home, "loophub.db"))).toBe(false);
  });

  test("shows general usage at the root", () => {
    const result = lh(["--help"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("lh — LoopHub CLI");
  });

  test("rejects an unknown nested command instead of showing parent help", () => {
    const result = lh(["issue", "definitely-not-a-command", "--help"]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("lh — LoopHub CLI");
    expect(result.stdout).not.toContain("lh issue — Manage issues.");
  });
});
