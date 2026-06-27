import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before db.ts runs its import-time setup (see core/store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-pty-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("./store.ts");
let P: typeof import("./pty.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  P = await import("./pty.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("resolveShell prefers explicit override, then SHELL, then per-OS default", () => {
  expect(
    P.resolveShell({ LOOPHUB_TERMINAL_SHELL: "/bin/zsh", SHELL: "/bin/sh" }),
  ).toBe("/bin/zsh");
  expect(P.resolveShell({ SHELL: "/bin/sh" })).toBe("/bin/sh");
  expect(P.resolveShell({}, "linux")).toBe("/bin/bash");
  expect(P.resolveShell({}, "win32")).toBe("powershell.exe");
  // Blank values are ignored, falling through to the next source.
  expect(
    P.resolveShell({ LOOPHUB_TERMINAL_SHELL: "  ", SHELL: "/bin/sh" }),
  ).toBe("/bin/sh");
});

test("resolveRepoCwd returns the registered base dir for a known repo", () => {
  // HOME is a real directory, so it passes the isDirectory() check.
  const repo = S.createRepo("me/term", HOME);
  expect(P.resolveRepoCwd(repo.full_name)).toBe(HOME);
});

test("resolveRepoCwd throws 404 for an unknown repo", () => {
  try {
    P.resolveRepoCwd("me/nope");
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err.status).toBe(404);
  }
});

test("resolveRepoCwd throws 422 when the base dir no longer exists", () => {
  const repo = S.createRepo("me/gone", join(HOME, "missing-dir"));
  try {
    P.resolveRepoCwd(repo.full_name);
    expect.unreachable("should have thrown");
  } catch (err: any) {
    expect(err.status).toBe(422);
  }
});

test("resolveTerminalCwd falls back to $HOME when no repo is given", () => {
  expect(P.resolveTerminalCwd()).toBe(homedir());
  expect(P.resolveTerminalCwd(null)).toBe(homedir());
  expect(P.resolveTerminalCwd("")).toBe(homedir());
  expect(P.resolveTerminalCwd("   ")).toBe(homedir());
});

test("resolveTerminalCwd resolves a named repo to its base dir", () => {
  const repo = S.createRepo("me/term-cwd", HOME);
  expect(P.resolveTerminalCwd(repo.full_name)).toBe(HOME);
});

test("initialCommandInput appends a CR to a non-empty command, null otherwise", () => {
  // A trailing CR submits the line so the command runs in the interactive shell.
  expect(P.initialCommandInput("lh dev 42")).toBe("lh dev 42\r");
  // Surrounding whitespace is trimmed before submitting.
  expect(P.initialCommandInput("  lh dev 42  ")).toBe("lh dev 42\r");
  // Nothing to run → no keystrokes (plain shell).
  expect(P.initialCommandInput()).toBeNull();
  expect(P.initialCommandInput(null)).toBeNull();
  expect(P.initialCommandInput("")).toBeNull();
  expect(P.initialCommandInput("   ")).toBeNull();
});
