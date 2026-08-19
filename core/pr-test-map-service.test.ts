import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-test-map-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;
let repoId: number;
let headSha: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

async function openPull(branch: string): Promise<number> {
  git(["checkout", "-q", "-B", branch, "main"]);
  writeFileSync(join(repoPath, `${branch}.txt`), "y\n");
  git(["add", "-A"]);
  git(["commit", "-qm", `${branch} work`]);
  const sha = git(["rev-parse", "HEAD"]).stdout.trim();
  git(["checkout", "-q", "main"]);
  const pr = await svc.pulls.create("me/proj", {
    title: branch,
    head: branch,
    base: "main",
  });
  headSha = sha;
  return pr.number;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-test-map-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  const repo = await svc.repos.create({ path: repoPath, name: "me/proj" });
  repoId = repo.id;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

function doc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    summary: "Covers storing a test map",
    files: [
      {
        path: "core/pr-test-map-service.test.ts",
        tests: [
          {
            suites: ["prTestMaps.create"],
            title: "stores the map against the PR's head",
            summary:
              "A saved map carries the head its excerpts were read from.",
            code: "expect(map.head_sha).toBe(headSha);",
            target: {
              path: "core/service/pr-test-maps.ts",
              code: "const headSha = given || (await revParse(...));",
            },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("a PR with no test map reads as null (#348)", async () => {
  const n = await openPull("none");
  expect(svc.prTestMaps.get("me/proj", n)).toBeNull();
});

test("create stores the map against the PR's head and announces it", async () => {
  const n = await openPull("stored");
  const map = await svc.prTestMaps.create("me/proj", n, { document: doc() });
  expect(map.head_sha).toBe(headSha);
  expect(map.document.files[0].tests[0].target?.path).toBe(
    "core/service/pr-test-maps.ts",
  );
  expect(svc.prTestMaps.get("me/proj", n)).toEqual(map);
  const events = S.listEvents(0, repoId, 200).filter(
    (e) => e.type === "pull_request.test_map_created",
  );
  expect(JSON.parse(events.at(-1)!.payload as string)).toEqual({
    number: n,
    head_sha: headSha,
  });
});

test("regenerating keeps the earlier map and shows the newest", async () => {
  const n = await openPull("regenerated");
  const first = await svc.prTestMaps.create("me/proj", n, {
    document: doc({ summary: "first" }),
    headSha: "0".repeat(40),
  });
  const second = await svc.prTestMaps.create("me/proj", n, {
    document: doc({ summary: "second" }),
  });
  expect(svc.prTestMaps.get("me/proj", n)).toEqual(second);
  expect(second.head_sha).not.toBe(first.head_sha);
  const row = S.getIssue(repoId, n)!;
  expect(JSON.parse(S.latestPrTestMap(row.id)!.document).summary).toBe(
    "second",
  );
});

// Well-formedness is refused; incompleteness is not. A map that misses a test file still saves —
// that is what Not covered is for — but a broken document has nothing useful to become.
test("a malformed document is rejected, naming what is wrong", async () => {
  const n = await openPull("malformed");
  const cases: [unknown, string][] = [
    [doc({ version: 2 }), "document.version"],
    [doc({ summary: "  " }), "document.summary"],
    [doc({ files: [] }), "document.files"],
    [doc({ files: [{ path: "a.test.ts", tests: [] }] }), "tests"],
  ];
  for (const [document, where] of cases) {
    await expect(
      svc.prTestMaps.create("me/proj", n, { document }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(where),
    });
  }
});

test("a non-SHA head is rejected", async () => {
  const n = await openPull("rejected");
  await expect(
    svc.prTestMaps.create("me/proj", n, {
      document: doc(),
      headSha: "not a sha",
    }),
  ).rejects.toMatchObject({ status: 422 });
});

test("an unknown PR is a 404", async () => {
  await expect(
    svc.prTestMaps.create("me/proj", 9999, { document: doc() }),
  ).rejects.toMatchObject({ status: 404 });
  expect(() => svc.prTestMaps.get("me/proj", 9999)).toThrow();
});
