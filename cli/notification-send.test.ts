import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");
const REPO = "me/notification-cli";

let home: string;
let repoPath: string;

function lh(args: string[], input?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-notification-cli-home-"));
  repoPath = mkdtempSync(join(tmpdir(), "loophub-notification-cli-repo-"));
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

test("lh notification send creates a topbar notification and can return JSON", () => {
  const { stdout, exitCode } = lh(
    [
      "notification",
      "send",
      "--repo",
      REPO,
      "--kind",
      "human_attention",
      "--title",
      "Needs review",
      "--body",
      "-",
      "--resource",
      "pull:7",
      "--herdr-pane-id",
      "w1:p2",
      "--source-key",
      "cli-test:notify",
      "--json",
    ],
    "Please check PR #7.\n",
  );

  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({
    kind: "human_attention",
    title: "Needs review",
    body: "Please check PR #7.\n",
    resource: {
      kind: "pull",
      number: 7,
      href: `/r/${REPO}/pulls/7`,
    },
    herdr_pane_id: "w1:p2",
    read_at: null,
  });
});

test("lh notification send fails when --kind is missing", () => {
  const { stderr, exitCode } = lh([
    "notification",
    "send",
    "--repo",
    REPO,
    "--title",
    "Missing kind",
    "--body",
    "body",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("--kind is required");
});

test("lh notification send rejects malformed resources with trailing fields", () => {
  const { stderr, exitCode } = lh([
    "notification",
    "send",
    "--repo",
    REPO,
    "--kind",
    "human_attention",
    "--title",
    "Bad resource",
    "--body",
    "body",
    "--resource",
    "pull:7:junk",
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain(
    "--resource must be repo, issue:<number>, or pull:<number>",
  );
});

test("usage lists notification send", () => {
  const { stdout, exitCode } = lh([]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("lh notification send --kind");
});
