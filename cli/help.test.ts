import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as SqliteNS from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { commandHelp } from "./help.ts";

const CLI = join(import.meta.dirname, "index.ts");
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof SqliteNS;
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
  test.each(commandHelp)("$path exits successfully with its description", ({
    path,
    description,
  }) => {
    const result = lh([...path, "--help"]);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(`lh ${path.join(" ")} — ${description}`);
  });

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
    const db = new DatabaseSync(join(home, "loophub.db"), { readOnly: true });
    try {
      const row = db.prepare("SELECT count(*) AS count FROM issues").get() as {
        count: number;
      };
      expect(row.count).toBe(0);
    } finally {
      db.close();
    }
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
