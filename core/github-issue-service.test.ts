import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-ghissue-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let store: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

// A fake gh fetch: records the refs it was asked for and returns canned content, so the import flow is
// exercised without `gh`/network. Mirrors the fakeDeps pattern in github-pull-service.test.ts.
function fakeDeps(content: {
  number: number;
  title: string;
  body: string;
  url: string;
}) {
  const calls: Array<{
    repoPath: string;
    ref: { owner: string; repo: string; number: number };
  }> = [];
  const deps = {
    async fetchIssue(
      repoPath: string,
      ref: { owner: string; repo: string; number: number },
    ) {
      calls.push({ repoPath, ref });
      return content;
    },
  };
  return { deps, calls };
}

beforeAll(async () => {
  svc = await import("./service.ts");
  store = await import("./store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-ghissue-repo-"));
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

test("import copies title/body verbatim and records the GitHub source link (#614)", async () => {
  const { deps, calls } = fakeDeps({
    number: 42,
    title: "Upstream bug",
    body: "Steps to reproduce\n- do X",
    url: "https://github.com/acme/widget/issues/42",
  });

  const i = (await svc.issues.import(
    "me/proj",
    { url: "https://github.com/acme/widget/issues/42" },
    null,
    deps as any,
  )) as any;

  // A fresh loophub issue with the GitHub title/body copied exactly (no summarization).
  expect(i.title).toBe("Upstream bug");
  expect(i.body).toBe("Steps to reproduce\n- do X");
  expect(i.github_issue).toMatchObject({
    owner: "acme",
    repo: "widget",
    number: 42,
    url: "https://github.com/acme/widget/issues/42",
  });
  // Fetch was asked for exactly the coordinates parsed from the URL, run in the destination repo.
  expect(calls).toHaveLength(1);
  expect(calls[0].ref).toEqual({ owner: "acme", repo: "widget", number: 42 });
  expect(calls[0].repoPath).toBe(store.getRepo("me", "proj")!.local_path);

  // The link is retrievable from the store for the created issue.
  const created = store.getIssue(store.getRepo("me", "proj")!.id, i.number)!;
  expect(store.getGithubIssue(created.id)).toMatchObject({ number: 42 });

  // Issue detail surfaces the link too (parity with PR detail's github_pull), off the cheap list path.
  const detail = (await svc.issues.get("me/proj", i.number)) as any;
  expect(detail.github_issue).toMatchObject({
    owner: "acme",
    repo: "widget",
    number: 42,
  });

  // Import emits issue.opened (not a bespoke issue.imported) so imported issues reach the same
  // consumers as create — chiefly the workflow worker (SUPPORTED_EVENTS). The github field marks it.
  const opened = svc.events
    .list({ repo: "me/proj", limit: 100 })
    .filter(
      (e: any) => e.type === "issue.opened" && e.payload?.number === i.number,
    );
  expect(opened).toHaveLength(1);
  expect(opened[0].payload).toMatchObject({ github: "acme/widget#42" });
});

test("one GitHub issue can be imported into multiple loophub issues (#614)", async () => {
  const { deps } = fakeDeps({
    number: 7,
    title: "Shared",
    body: "b",
    url: "https://github.com/acme/widget/issues/7",
  });

  const a = (await svc.issues.import(
    "me/proj",
    { url: "https://github.com/acme/widget/issues/7" },
    null,
    deps as any,
  )) as any;
  const b = (await svc.issues.import(
    "me/proj",
    { url: "https://github.com/acme/widget/issues/7" },
    null,
    deps as any,
  )) as any;

  // Two distinct loophub issues, both linked to the same GitHub source.
  expect(a.number).not.toBe(b.number);
  const repoId = store.getRepo("me", "proj")!.id;
  const aRow = store.getIssue(repoId, a.number)!;
  const bRow = store.getIssue(repoId, b.number)!;
  expect(store.getGithubIssue(aRow.id)).toMatchObject({
    owner: "acme",
    repo: "widget",
    number: 7,
  });
  expect(store.getGithubIssue(bRow.id)).toMatchObject({
    owner: "acme",
    repo: "widget",
    number: 7,
  });
});

test("import rejects a non-GitHub-issue URL before fetching (#614)", async () => {
  const { deps, calls } = fakeDeps({
    number: 1,
    title: "t",
    body: "b",
    url: "https://github.com/o/r/issues/1",
  });
  await expect(
    svc.issues.import(
      "me/proj",
      { url: "https://github.com/o/r/pull/1" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/GitHub issue URL/);
  // No fetch is spent on an invalid URL.
  expect(calls).toHaveLength(0);
});

test("import surfaces a fetch failure as a 502 (#614)", async () => {
  const deps = {
    async fetchIssue() {
      throw new Error("gh issue view failed: not found");
    },
  };
  await expect(
    svc.issues.import(
      "me/proj",
      { url: "https://github.com/acme/widget/issues/999" },
      null,
      deps as any,
    ),
  ).rejects.toThrow(/failed to fetch GitHub issue/);
});

test("removeRepo sweeps github_issues so repo removal does not fail the FK (#614)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lh-ghissue-rm-"));
  const g = (args: string[]) =>
    spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  g(["init", "-q", "-b", "main"]);
  g(["config", "user.email", "t@t.local"]);
  g(["config", "user.name", "tester"]);
  writeFileSync(join(dir, "a.txt"), "x\n");
  g(["add", "-A"]);
  g(["commit", "-qm", "init"]);
  await svc.repos.create({ path: dir, name: "me/throwaway" });

  const { deps } = fakeDeps({
    number: 3,
    title: "t",
    body: "b",
    url: "https://github.com/acme/widget/issues/3",
  });
  await svc.issues.import(
    "me/throwaway",
    { url: "https://github.com/acme/widget/issues/3" },
    null,
    deps as any,
  );

  // Before the sweep this threw "FOREIGN KEY constraint failed"; now it removes cleanly.
  expect(() => svc.repos.remove("me/throwaway")).not.toThrow();
  expect(() => svc.repos.get("me/throwaway")).toThrow();
  rmSync(dir, { recursive: true, force: true });
});
