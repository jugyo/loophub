import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/inbox-cli";

let home: string;
let repoPath: string;

function lh(args: string[], input?: string) {
  const r = spawnSync(
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
      input,
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
      },
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-inbox-cli-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "loophub-inbox-cli-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  const add = lh(["repo", "add", repoPath, "--name", REPO]);
  if (add.exitCode !== 0) throw new Error(`repo add failed: ${add.stderr}`);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh inbox send creates a message and can return JSON", () => {
  const { stdout, exitCode } = lh(
    [
      "inbox",
      "send",
      "--repo",
      REPO,
      "--from",
      JSON.stringify({ kind: "agent", repo: REPO, actor: "impl-bot" }),
      "--to",
      JSON.stringify({ kind: "human" }),
      "--label",
      "review",
      "--title",
      "Ready",
      "--body",
      "-",
      "--json",
    ],
    "PR is ready.\n",
  );

  expect(exitCode).toBe(0);
  const message = JSON.parse(stdout);
  expect(message).toMatchObject({
    from: { kind: "agent", repo: REPO, actor: "impl-bot" },
    to: { kind: "human" },
    label: "review",
    title: "Ready",
    body: "PR is ready.\n",
    state: "unread",
  });

  for (const [subcommand, state] of [
    ["read", "read"],
    ["unread", "unread"],
    ["archive", "archived"],
    ["unarchive", "read"],
    ["delete", "deleted"],
  ] as const) {
    const updated = lh(["inbox", subcommand, String(message.id), "--json"]);
    expect(updated.exitCode).toBe(0);
    expect(JSON.parse(updated.stdout)).toMatchObject({
      id: message.id,
      state,
    });
  }
});

test("lh inbox send fails when --from is missing", () => {
  const { stderr, exitCode } = lh([
    "inbox",
    "send",
    "--repo",
    REPO,
    "--title",
    "Missing source",
    "--body",
    "body",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--from is required");
});

test("usage lists inbox send", () => {
  const { stdout, exitCode } = lh([]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("lh inbox send --from");
  expect(stdout).toContain("lh inbox read|unread|archive|unarchive|delete");
});
