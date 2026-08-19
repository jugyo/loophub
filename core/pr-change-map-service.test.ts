import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-change-map-svc-"));
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
  repoPath = mkdtempSync(join(tmpdir(), "lh-change-map-repo-"));
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

test("a PR with no change map reads as null (#344)", async () => {
  const n = await openPull("none");
  expect(svc.prChangeMaps.get("me/proj", n)).toBeNull();
});

function doc(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    summary: "Stored the map",
    categories: [
      {
        name: "Storing the map",
        summary: "Where a generated map lands",
        changes: [
          {
            name: "Change map rows",
            kind: "store",
            summary: "Insert one, read the newest",
            files: ["core/store/change-maps.ts"],
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("create stores the map against the PR's head and announces it", async () => {
  const n = await openPull("stored");
  const map = await svc.prChangeMaps.create("me/proj", n, {
    document: doc(),
  });
  expect(map.head_sha).toBe(headSha);
  // Bare paths come back normalized — the wire always carries file entries, whichever form the
  // agent wrote.
  expect(map.document.categories[0].changes[0].files).toEqual([
    { path: "core/store/change-maps.ts" },
  ]);
  expect(map.document.summary).toBe("Stored the map");
  expect(svc.prChangeMaps.get("me/proj", n)).toEqual(map);
  const events = S.listEvents(0, repoId, 200).filter(
    (e) => e.type === "pull_request.change_map_created",
  );
  expect(JSON.parse(events.at(-1)!.payload as string)).toEqual({
    number: n,
    head_sha: headSha,
  });
});

test("regenerating keeps the earlier map and shows the newest", async () => {
  const n = await openPull("regenerated");
  const first = await svc.prChangeMaps.create("me/proj", n, {
    document: doc({ summary: "first" }),
    headSha: "0".repeat(40),
  });
  const second = await svc.prChangeMaps.create("me/proj", n, {
    document: doc({ summary: "second" }),
  });
  expect(svc.prChangeMaps.get("me/proj", n)).toEqual(second);
  expect(second.head_sha).not.toBe(first.head_sha);
  const row = S.getIssue(repoId, n)!;
  expect(JSON.parse(S.latestPrChangeMap(row.id)!.document).summary).toBe(
    "second",
  );
});

// Well-formedness is refused; incompleteness is not. A map that leaves files unmentioned still
// saves — that is what Not covered is for — but a broken document has nothing useful to become.
test("a malformed document is rejected, naming what is wrong", async () => {
  const n = await openPull("malformed");
  const cases: [unknown, string][] = [
    [doc({ version: 2 }), "document.version"],
    [doc({ summary: "  " }), "document.summary"],
    [doc({ categories: [] }), "document.categories"],
    [
      doc({
        categories: [
          {
            name: "x",
            summary: "y",
            changes: [{ name: "n", kind: "k", summary: "s", files: [] }],
          },
        ],
      }),
      "files",
    ],
  ];
  for (const [document, where] of cases) {
    await expect(
      svc.prChangeMaps.create("me/proj", n, { document }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining(where),
    });
  }
});

test("more than six categories is rejected", async () => {
  const n = await openPull("too-many");
  const category = (i: number) => ({
    name: `c${i}`,
    summary: "s",
    changes: [{ name: "n", kind: "k", summary: "s", files: ["a.txt"] }],
  });
  await expect(
    svc.prChangeMaps.create("me/proj", n, {
      document: doc({ categories: [1, 2, 3, 4, 5, 6, 7].map(category) }),
    }),
  ).rejects.toMatchObject({ status: 422 });
  // Six is still fine — the cap is a ceiling, not a target.
  await expect(
    svc.prChangeMaps.create("me/proj", n, {
      document: doc({ categories: [1, 2, 3, 4, 5, 6].map(category) }),
    }),
  ).resolves.toMatchObject({ head_sha: expect.any(String) });
});

test("a non-SHA head is rejected", async () => {
  const n = await openPull("rejected");
  await expect(
    svc.prChangeMaps.create("me/proj", n, {
      document: doc(),
      headSha: "not a sha",
    }),
  ).rejects.toMatchObject({ status: 422 });
});

test("an unknown PR is a 404", async () => {
  await expect(
    svc.prChangeMaps.create("me/proj", 9999, { document: doc() }),
  ).rejects.toMatchObject({ status: 404 });
  expect(() => svc.prChangeMaps.get("me/proj", 9999)).toThrow();
});
