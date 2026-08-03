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
  git(["checkout", "-q", "-B", "feature", "main"]);
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

test("linked GitHub PR commits exclude the remote base history", async () => {
  const number = await openPull();
  const featureSha = git(["rev-parse", "feature"]).stdout.trim();

  try {
    git(["checkout", "-q", "-B", "github-base", "main"]);
    writeFileSync(join(repoPath, "remote-base.txt"), "remote base\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "remote base work"]);
    const remoteBaseSha = git(["rev-parse", "HEAD"]).stdout.trim();
    git(["update-ref", "refs/remotes/origin/main", remoteBaseSha]);

    git(["checkout", "-q", "feature"]);
    git(["merge", "--no-edit", "origin/main"]);
    const mergeSha = git(["rev-parse", "HEAD"]).stdout.trim();
    git(["checkout", "-q", "main"]);

    const localOnly = (await svc.pulls.get("me/proj", number)) as any;
    const localOnlyShas = localOnly.commits.map((commit: any) => commit.sha);
    expect(localOnlyShas).toHaveLength(3);
    expect(localOnlyShas).toEqual(
      expect.arrayContaining([mergeSha, remoteBaseSha, featureSha]),
    );

    svc.pulls.recordGithubPull("me/proj", number, {
      github_number: 44,
      url: "https://github.com/me/proj/pull/44",
      branch: "feature/remote-base",
    });
    const linked = (await svc.pulls.get("me/proj", number)) as any;
    expect(linked.commits.map((commit: any) => commit.sha)).toEqual([
      mergeSha,
      featureSha,
    ]);
  } finally {
    git(["checkout", "-q", "main"]);
    git(["update-ref", "refs/remotes/origin/main", "main"]);
    git(["branch", "-D", "github-base"]);
  }
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

test("recordGithubPull derives github_number from the url when omitted (#487)", async () => {
  const number = await openPull();
  const rec = svc.pulls.recordGithubPull("me/proj", number, {
    url: "https://github.com/me/proj/pull/77",
  });
  expect(rec.number).toBe(77);
  const after = (await svc.pulls.get("me/proj", number)) as any;
  expect(after.github_pull).toMatchObject({ number: 77 });
});

test("recordGithubPull rejects a url with no derivable PR number and no github_number (#487)", async () => {
  const number = await openPull();
  expect(() =>
    svc.pulls.recordGithubPull("me/proj", number, {
      url: "https://github.com/me/proj",
    }),
  ).toThrow(/github_number/);
});

// #411: createGithubPull orchestration. push + gh are injected fakes so the test runs without a
// GitHub remote/network; the DB record, double-create guard, and validation are exercised for real.
type GhCalls = {
  push: Array<{
    repoPath: string;
    head: string;
    branch: string;
    force?: boolean;
  }>;
  view: Array<{ repoPath: string; branch: string }>;
  create: Array<{
    repoPath: string;
    input: { base: string; head: string; title: string; body: string };
  }>;
};

function fakeDeps(opts: {
  viewResult?: { number: number; url: string } | null;
  createResult?: { number: number; url: string };
}) {
  const calls: GhCalls = { push: [], view: [], create: [] };
  const deps = {
    async push(
      repoPath: string,
      head: string,
      branch: string,
      pushOpts: { force?: boolean } = {},
    ) {
      calls.push.push({ repoPath, head, branch, force: pushOpts.force });
    },
    async view(repoPath: string, branch: string) {
      calls.view.push({ repoPath, branch });
      return opts.viewResult ?? null;
    },
    async create(
      repoPath: string,
      input: { base: string; head: string; title: string; body: string },
    ) {
      calls.create.push({ repoPath, input });
      return (
        opts.createResult ?? {
          number: 77,
          url: "https://github.com/me/proj/pull/77",
        }
      );
    },
  };
  return { deps, calls };
}

test("createGithubPull pushes, creates a Draft PR, and records it (#411)", async () => {
  const number = await openPull();
  const { deps, calls } = fakeDeps({
    createResult: { number: 100, url: "https://github.com/me/proj/pull/100" },
  });

  const rec = await svc.pulls.createGithubPull(
    "me/proj",
    number,
    { branch: "feature/export", title: "Add export", body: "## Summary\nx" },
    null,
    deps as any,
  );
  expect(rec).toMatchObject({
    number: 100,
    url: "https://github.com/me/proj/pull/100",
    branch: "feature/export",
  });

  // Pushed the internal head ref under the content-based branch; created with base from the PR.
  expect(calls.push).toHaveLength(1);
  expect(calls.push[0]).toMatchObject({
    head: "feature",
    branch: "feature/export",
  });
  expect(calls.create).toHaveLength(1);
  expect(calls.create[0].input).toMatchObject({
    base: "main",
    head: "feature/export",
    title: "Add export",
  });

  // The loophub PR now carries the github_pull.
  const after = (await svc.pulls.get("me/proj", number)) as any;
  expect(after.github_pull).toMatchObject({ number: 100 });
});

test("createGithubPull recovers a created-but-unrecorded PR instead of duplicating (#411)", async () => {
  const number = await openPull();
  // view returns an existing PR → create must NOT be called (atomic recovery).
  const { deps, calls } = fakeDeps({
    viewResult: { number: 55, url: "https://github.com/me/proj/pull/55" },
  });

  const rec = await svc.pulls.createGithubPull(
    "me/proj",
    number,
    { branch: "feature/again", title: "t", body: "b" },
    null,
    deps as any,
  );
  expect(rec.number).toBe(55);
  expect(calls.push).toHaveLength(1);
  expect(calls.create).toHaveLength(0);
});

test("createGithubPull refuses to re-create a GitHub PR when one is already recorded (#411)", async () => {
  const number = await openPull();
  const { deps } = fakeDeps({});
  await svc.pulls.createGithubPull(
    "me/proj",
    number,
    { branch: "feature/once", title: "t", body: "b" },
    null,
    deps as any,
  );
  // Second call hits the double-create guard before touching push/gh.
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "feature/twice", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/already has a GitHub PR/);
});

test("createGithubPull validates branch/title/body and rejects the internal branch (#411)", async () => {
  const number = await openPull();
  const { deps } = fakeDeps({});
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/branch is required/);
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "feature/x", title: "", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/title is required/);
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "feature/x", title: "t", body: "  " },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/body is required/);
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "loophub/issue-1", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/content-based/);
});

test("createGithubPull rejects a branch with injection-prone characters (#411)", async () => {
  const number = await openPull();
  const { deps, calls } = fakeDeps({});
  // Leading "-" would be parsed as a flag by gh/git (argument injection).
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "--repo=evil/repo", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/invalid characters/);
  // Odd characters / traversal are also rejected, before anything is pushed.
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "feature/x;rm -rf", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/invalid characters/);
  expect(calls.push).toHaveLength(0);
});

test("createGithubPull refuses to push onto the base or head branch (#411)", async () => {
  const number = await openPull(); // head=feature, base=main
  const { deps, calls } = fakeDeps({});
  // branch === base would fast-forward base directly, bypassing the Draft-PR flow.
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "main", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/differ from the PR's base and head/);
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "feature", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/differ from the PR's base and head/);
  expect(calls.push).toHaveLength(0);
});

test("createGithubPull propagates a transient view failure instead of duplicating (#411)", async () => {
  const number = await openPull();
  // A flaky `gh pr view` on a retry must NOT be treated as "no PR" (which would fall through to
  // create and risk a duplicate) — it surfaces as an error so the run can be retried cleanly.
  const calls = { create: 0 };
  const deps = {
    async push() {},
    async view() {
      throw new Error("gh pr view failed: network");
    },
    async create() {
      calls.create += 1;
      return { number: 1, url: "https://github.com/me/proj/pull/1" };
    },
  };
  await expect(
    svc.pulls.createGithubPull(
      "me/proj",
      number,
      { branch: "feature/transient", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/failed to create GitHub PR/);
  expect(calls.create).toBe(0);
});

test("createGithubPull requires a GitHub origin remote (#411)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-ghpr-norem-"));
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
  await svc.repos.create({ path: dir, name: "me/norem" });
  const pr = await svc.pulls.create("me/norem", {
    title: "feat",
    head: "feature",
    base: "main",
  });
  const { deps } = fakeDeps({});
  await expect(
    svc.pulls.createGithubPull(
      "me/norem",
      pr.number,
      { branch: "feature/x", title: "t", body: "b" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/GitHub origin/);
  svc.repos.remove("me/norem");
  rmSync(dir, { recursive: true, force: true });
});

// #848: pushGithubPull re-pushes the current head to the already-recorded GitHub branch.
test("createGithubPull records the pushed head SHA so unpushed changes are detectable (#848)", async () => {
  const number = await openPull();
  const { deps } = fakeDeps({
    createResult: { number: 300, url: "https://github.com/me/proj/pull/300" },
  });
  await svc.pulls.createGithubPull(
    "me/proj",
    number,
    { branch: "feature/sha", title: "t", body: "b" },
    null,
    deps as any,
  );
  const after = (await svc.pulls.get("me/proj", number)) as any;
  // pushed_sha == the PR's live head at export time: no unpushed changes right after creating.
  expect(after.github_pull.pushed_sha).toBe(after.head.sha);
});

test("pushGithubPull pushes the head to the recorded branch and updates pushed_sha (#848)", async () => {
  const number = await openPull();
  const { deps, calls } = fakeDeps({
    createResult: { number: 301, url: "https://github.com/me/proj/pull/301" },
  });
  await svc.pulls.createGithubPull(
    "me/proj",
    number,
    { branch: "feature/repush", title: "t", body: "b" },
    null,
    deps as any,
  );
  const created = (await svc.pulls.get("me/proj", number)) as any;
  const firstSha = created.head.sha;
  expect(created.commits).toEqual([
    expect.objectContaining({ sha: firstSha, pushed_to_github: true }),
  ]);

  // A new commit moves the PR's head past what was exported — now there are unpushed changes.
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "c.txt"), "z\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "more work"]);
  git(["checkout", "-q", "main"]);
  const moved = (await svc.pulls.get("me/proj", number)) as any;
  expect(moved.head.sha).not.toBe(firstSha);
  expect(moved.github_pull.pushed_sha).toBe(firstSha); // still the old pushed SHA
  expect(moved.commits).toEqual([
    expect.objectContaining({
      sha: moved.head.sha,
      pushed_to_github: false,
    }),
    expect.objectContaining({ sha: firstSha, pushed_to_github: true }),
  ]);

  const rec = await svc.pulls.pushGithubPull(
    "me/proj",
    number,
    {},
    null,
    deps as any,
  );
  expect(rec).toMatchObject({
    number: 301,
    branch: "feature/repush",
    pushed_sha: moved.head.sha,
  });
  // Pushed the internal head ref under the recorded content-based branch (no new gh create), and
  // without force — the plain action never rewrites the GitHub branch (#1861).
  expect(calls.push.at(-1)).toMatchObject({
    head: "feature",
    branch: "feature/repush",
    force: false,
  });
  expect(calls.create).toHaveLength(1); // only the original create, none from the push

  const afterPush = (await svc.pulls.get("me/proj", number)) as any;
  expect(afterPush.github_pull.pushed_sha).toBe(moved.head.sha);
  expect(
    afterPush.commits.every((commit: any) => commit.pushed_to_github === true),
  ).toBe(true);

  // If the recorded SHA is no longer in the current PR history, do not claim that any commit was
  // pushed. This can happen after a local history rewrite while pushed_sha still names the old tip.
  git(["branch", "-f", "feature", "main"]);
  git(["checkout", "-q", "feature"]);
  writeFileSync(join(repoPath, "rewritten.txt"), "rewritten\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "rewritten work"]);
  git(["checkout", "-q", "main"]);
  const rewritten = (await svc.pulls.get("me/proj", number)) as any;
  expect(rewritten.commits).toHaveLength(1);
  expect(rewritten.commits[0]).not.toHaveProperty("pushed_to_github");

  git(["branch", "-f", "feature", afterPush.head.sha]);
});

test("pushGithubPull force-pushes a rewritten head and updates pushed_sha (#1861)", async () => {
  const number = await openPull();
  const { deps, calls } = fakeDeps({
    createResult: { number: 304, url: "https://github.com/me/proj/pull/304" },
  });
  await svc.pulls.createGithubPull(
    "me/proj",
    number,
    { branch: "feature/force", title: "t", body: "b" },
    null,
    deps as any,
  );
  const created = (await svc.pulls.get("me/proj", number)) as any;

  // Amend the head: the GitHub branch no longer descends from it, so a plain push would be rejected.
  git(["checkout", "-q", "feature"]);
  git(["commit", "-q", "--amend", "-m", "amended work"]);
  git(["checkout", "-q", "main"]);
  const amended = (await svc.pulls.get("me/proj", number)) as any;
  expect(amended.head.sha).not.toBe(created.head.sha);

  const rec = await svc.pulls.pushGithubPull(
    "me/proj",
    number,
    { force: true },
    null,
    deps as any,
  );
  expect(rec).toMatchObject({
    number: 304,
    branch: "feature/force",
    pushed_sha: amended.head.sha,
  });
  expect(calls.push.at(-1)).toMatchObject({
    head: "feature",
    branch: "feature/force",
    force: true,
  });
  expect(calls.create).toHaveLength(1); // still no re-create

  // A rejected force push surfaces as an error instead of recording a new pushed_sha.
  const failing = {
    ...deps,
    push: async () => {
      throw new Error("stale info");
    },
  };
  await expect(
    svc.pulls.pushGithubPull(
      "me/proj",
      number,
      { force: true },
      null,
      failing as any,
    ),
  ).rejects.toThrow(/failed to force-push branch: stale info/);
});

test("pushGithubPull refuses a PR with no recorded GitHub PR (#848)", async () => {
  const number = await openPull();
  const { deps, calls } = fakeDeps({});
  await expect(
    svc.pulls.pushGithubPull("me/proj", number, {}, null, deps as any),
  ).rejects.toThrow(/no GitHub PR to push to/);
  expect(calls.push).toHaveLength(0);
});

test("pushGithubPull refuses a recorded PR that has no branch to push to (#848)", async () => {
  const number = await openPull();
  // record-github-pr may attach a link without a branch — nothing to push onto.
  svc.pulls.recordGithubPull("me/proj", number, {
    url: "https://github.com/me/proj/pull/302",
  });
  const { deps, calls } = fakeDeps({});
  await expect(
    svc.pulls.pushGithubPull("me/proj", number, {}, null, deps as any),
  ).rejects.toThrow(/no branch to push to/);
  expect(calls.push).toHaveLength(0);
});

test("pushGithubPull rejects a recorded branch with injection-prone characters (#848)", async () => {
  const number = await openPull();
  // record-github-pr stores the branch unvalidated; pushGithubPull re-checks it before pushing.
  svc.pulls.recordGithubPull("me/proj", number, {
    url: "https://github.com/me/proj/pull/303",
    branch: "--force",
  });
  const { deps, calls } = fakeDeps({});
  await expect(
    svc.pulls.pushGithubPull("me/proj", number, {}, null, deps as any),
  ).rejects.toThrow(/invalid characters/);
  expect(calls.push).toHaveLength(0);
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
