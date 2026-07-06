import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-ghmerge-sync-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let sync: typeof import("./github-merge-sync.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function openGithubLinkedPull(githubNumber: number): Promise<{
  number: number;
  issueId: number;
}> {
  const branch = `feature-${githubNumber}`;
  git(["checkout", "-q", "-b", branch]);
  writeFileSync(join(repoPath, `${branch}.txt`), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "feature work"]);
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", {
    title: "feat",
    head: branch,
    base: "main",
  });
  svc.pulls.recordGithubPull("me/proj", pr.number, {
    github_number: githubNumber,
    url: `https://github.com/me/proj/pull/${githubNumber}`,
  });
  const repo = await svc.repos.get("me/proj");
  const issue = S.getIssue(repo.id, pr.number)!;
  return { number: pr.number, issueId: issue.id };
}

function fakeDeps(
  results: Record<
    string,
    { merged: boolean; mergedAt: string | null; mergedByLogin: string | null }
  >,
) {
  const calls: string[] = [];
  return {
    calls,
    deps: {
      async fetchMergeStatus(_repoPath: string, url: string) {
        calls.push(url);
        const r = results[url];
        if (!r) throw new Error(`unexpected url: ${url}`);
        return r;
      },
    },
  };
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  sync = await import("./github-merge-sync.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-ghmerge-repo-"));
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

test("detects a GitHub merge and records it on github_pulls (#800)", async () => {
  const { number, issueId } = await openGithubLinkedPull(101);
  const { deps } = fakeDeps({
    "https://github.com/me/proj/pull/101": {
      merged: true,
      mergedAt: "2026-01-01T00:00:00Z",
      mergedByLogin: "octocat",
    },
  });

  const emitted = await sync.syncGithubMergeStatus(deps);

  expect(emitted).toHaveLength(1);
  expect(emitted[0]).toMatchObject({
    type: "pull_request.github_merged",
    actor: "octocat",
  });
  expect(JSON.parse(emitted[0].payload)).toMatchObject({
    number,
    github_number: 101,
    github_merged_at: "2026-01-01T00:00:00Z",
  });

  const rec = S.getGithubPull(issueId)!;
  expect(rec.github_merged).toBe(1);
  expect(rec.github_merged_at).toBe("2026-01-01T00:00:00Z");
});

test("leaves an unmerged GitHub PR untouched and keeps polling it (#800)", async () => {
  const { issueId } = await openGithubLinkedPull(102);
  const { deps, calls } = fakeDeps({
    "https://github.com/me/proj/pull/102": {
      merged: false,
      mergedAt: null,
      mergedByLogin: null,
    },
  });

  const emitted = await sync.syncGithubMergeStatus(deps);
  expect(emitted).toHaveLength(0);
  expect(S.getGithubPull(issueId)!.github_merged).toBe(0);

  // Still shows up on the next sweep since it wasn't recorded as merged.
  expect(calls).toContain("https://github.com/me/proj/pull/102");
});

test("a gh failure on one link is skipped without blocking the rest of the sweep (#800)", async () => {
  const a = await openGithubLinkedPull(201);
  const b = await openGithubLinkedPull(202);
  const calls: string[] = [];
  const deps = {
    async fetchMergeStatus(_repoPath: string, url: string) {
      calls.push(url);
      if (url.endsWith("/201")) throw new Error("gh pr view failed: boom");
      if (url.endsWith("/202"))
        return {
          merged: true,
          mergedAt: "2026-02-02T00:00:00Z",
          mergedByLogin: null,
        };
      // Any other still-unmerged link from an earlier test — report unmerged so this fake
      // doesn't have the side effect of flipping unrelated rows to merged.
      return { merged: false, mergedAt: null, mergedByLogin: null };
    },
  };

  const emitted = await sync.syncGithubMergeStatus(deps);

  // Both links were attempted (the failure on 201 didn't stop 202 from being checked)...
  expect(calls).toEqual(
    expect.arrayContaining([
      "https://github.com/me/proj/pull/201",
      "https://github.com/me/proj/pull/202",
    ]),
  );
  // ...but only 202's merge was recorded/emitted.
  const payloads = emitted.map((e) => JSON.parse(e.payload));
  expect(payloads.some((p) => p.github_number === 202)).toBe(true);
  expect(payloads.some((p) => p.github_number === 201)).toBe(false);
  expect(S.getGithubPull(a.issueId)!.github_merged).toBe(0);
  expect(S.getGithubPull(b.issueId)!.github_merged).toBe(1);
});

test("a merged loophub PR (or one without a GitHub link) is not polled (#800)", async () => {
  // No GitHub link at all.
  const plain = await svc.pulls.create("me/proj", {
    title: "no-link",
    head: "main",
    base: "main",
  });
  void plain;

  const { number, issueId } = await openGithubLinkedPull(301);
  await svc.pulls.merge("me/proj", number, "merge");

  const { deps, calls } = fakeDeps({
    "https://github.com/me/proj/pull/301": {
      merged: true,
      mergedAt: "2026-03-03T00:00:00Z",
      mergedByLogin: null,
    },
  });

  const emitted = await sync.syncGithubMergeStatus(deps);
  // The already-merged-on-loophub PR's link is excluded from the sweep entirely (never even
  // reaches `gh`); other still-open unmerged links from earlier tests may still be attempted.
  expect(calls).not.toContain("https://github.com/me/proj/pull/301");
  expect(emitted.some((e) => JSON.parse(e.payload).github_number === 301)).toBe(
    false,
  );
  expect(S.getGithubPull(issueId)!.github_merged).toBe(0);
});
