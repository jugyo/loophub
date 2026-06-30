import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-ghpr-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function openPull(): Promise<number> {
  // A feature branch off main so the PR has a real head/base.
  git(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(repoPath, "b.txt"), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", {
    title: "feat",
    head: "feature",
    base: "main",
  });
  return pr.number;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-ghpr-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("mergeMode defaults to 'merge' for a repo with no GitHub remote (#406)", async () => {
  const m = await svc.repos.mergeMode("me/proj");
  expect(m).toEqual({
    setting: null,
    has_github_remote: false,
    effective: "merge",
  });
});

test("a GitHub remote flips the effective default to 'github_pr' (#406)", async () => {
  git(["remote", "add", "origin", "https://github.com/me/proj.git"]);
  const m = await svc.repos.mergeMode("me/proj");
  expect(m.has_github_remote).toBe(true);
  expect(m.setting).toBeNull();
  expect(m.effective).toBe("github_pr");
});

test("setMergeMode pins a mode and 'auto' clears it back to the default (#406)", async () => {
  const pinned = svc.repos.setMergeMode("me/proj", "merge");
  expect(pinned.merge_mode).toBe("merge");
  expect((await svc.repos.mergeMode("me/proj")).effective).toBe("merge");

  // Pinned setting overrides the GitHub-remote default.
  const cleared = svc.repos.setMergeMode("me/proj", "auto");
  expect(cleared.merge_mode).toBeNull();
  expect((await svc.repos.mergeMode("me/proj")).effective).toBe("github_pr");
});

test("setMergeMode rejects an unknown mode (#406)", () => {
  expect(() => svc.repos.setMergeMode("me/proj", "nope" as any)).toThrow(
    /mode must be/,
  );
});

test("recordGithubPull links a GitHub PR and pull detail exposes it (#406)", async () => {
  const number = await openPull();

  // Before recording: no github_pull, effective mode reflects the GitHub remote.
  const before = (await svc.pulls.get("me/proj", number)) as any;
  expect(before.github_pull).toBeNull();
  expect(before.merge_mode).toBe("github_pr");

  const rec = svc.pulls.recordGithubPull("me/proj", number, {
    github_number: 42,
    url: "https://github.com/me/proj/pull/42",
    branch: "feature/feat",
  });
  expect(rec).toMatchObject({
    number: 42,
    url: "https://github.com/me/proj/pull/42",
    branch: "feature/feat",
  });

  const after = (await svc.pulls.get("me/proj", number)) as any;
  expect(after.github_pull).toMatchObject({ number: 42 });

  // Idempotent on the PR: re-recording overwrites rather than erroring.
  const rec2 = svc.pulls.recordGithubPull("me/proj", number, {
    github_number: 43,
    url: "https://github.com/me/proj/pull/43",
  });
  expect(rec2.number).toBe(43);
  const after2 = (await svc.pulls.get("me/proj", number)) as any;
  expect(after2.github_pull.number).toBe(43);
});

test("recordGithubPull validates the URL and PR number (#406)", async () => {
  const number = await openPull();
  expect(() =>
    svc.pulls.recordGithubPull("me/proj", number, {
      github_number: 1,
      url: "not-a-url",
    }),
  ).toThrow(/url must be/);
  // Non-GitHub host is rejected even with a valid http(s) scheme — the model + UI are GitHub-only.
  expect(() =>
    svc.pulls.recordGithubPull("me/proj", number, {
      github_number: 1,
      url: "https://evil.example/me/proj/pull/1",
    }),
  ).toThrow(/GitHub/);
  expect(() =>
    svc.pulls.recordGithubPull("me/proj", number, {
      github_number: 0,
      url: "https://github.com/me/proj/pull/1",
    }),
  ).toThrow(/github_number/);
});

test("removeRepo sweeps github_pulls so repo removal does not fail the FK (#406)", async () => {
  // Isolated git repo + LoopHub repo so removal does not disturb the shared me/proj fixture.
  const dir = mkdtempSync(join(tmpdir(), "lh-ghpr-rm-"));
  const g = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  g(["checkout", "-q", "-b", "feature"]);
  writeFileSync(join(dir, "b.txt"), "y\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "feat"]);
  g(["checkout", "-q", "main"]);

  await svc.repos.create({ path: dir, name: "me/throwaway" });
  const pr = await svc.pulls.create("me/throwaway", {
    title: "feat",
    head: "feature",
    base: "main",
  });
  svc.pulls.recordGithubPull("me/throwaway", pr.number, {
    github_number: 5,
    url: "https://github.com/me/throwaway/pull/5",
  });

  // Before the fix this threw "FOREIGN KEY constraint failed"; now it removes cleanly.
  expect(() => svc.repos.remove("me/throwaway")).not.toThrow();
  expect(() => svc.repos.get("me/throwaway")).toThrow();
  rmSync(dir, { recursive: true, force: true });
});
