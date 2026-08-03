import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-stats-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");

  // Two repos so the per-repo grouping is observable. Rows are seeded at the store
  // layer (no git needed): stats.get aggregates the DB only.
  const a = S.createRepo("me/alpha", "/tmp/alpha");
  const b = S.createRepo("me/beta", "/tmp/beta");

  // me/alpha: 2 open + 1 closed issue; 1 open PR, 1 merged PR, 1 closed-unmerged PR.
  S.createIssue(a.id, "issue", "open 1", "", "t");
  S.createIssue(a.id, "issue", "open 2", "", "t");
  const closedIssue = S.createIssue(a.id, "issue", "closed", "", "t");
  S.updateIssue(closedIssue.id, { state: "closed" });

  const openPr = S.createIssue(a.id, "pull", "pr open", "", "t");
  S.createPull(openPr.id, "b1", "main", null);
  const mergedPr = S.createIssue(a.id, "pull", "pr merged", "", "t");
  S.createPull(mergedPr.id, "b2", "main", null);
  S.setMerged(mergedPr.id, "deadbeef", "squash");
  const closedPr = S.createIssue(a.id, "pull", "pr closed", "", "t");
  S.createPull(closedPr.id, "b3", "main", null);
  S.updateIssue(closedPr.id, { state: "closed" });

  const archivedOpenPr = S.createIssue(a.id, "pull", "archived open", "", "t");
  S.createPull(archivedOpenPr.id, "b4", "main", null);
  S.archivePull(archivedOpenPr.id);
  const archivedMergedPr = S.createIssue(
    a.id,
    "pull",
    "archived merged",
    "",
    "t",
  );
  S.createPull(archivedMergedPr.id, "b5", "main", null);
  S.setMerged(archivedMergedPr.id, "feedface", "squash");
  S.archivePull(archivedMergedPr.id);
  const archivedClosedPr = S.createIssue(
    a.id,
    "pull",
    "archived closed",
    "",
    "t",
  );
  S.createPull(archivedClosedPr.id, "b6", "main", null);
  S.updateIssue(archivedClosedPr.id, { state: "closed" });
  S.archivePull(archivedClosedPr.id);

  // me/beta: stays empty — all counts must read 0, not be missing.
  void b;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

describe("stats.get", () => {
  test("counts active PRs per repo, separating merged from closed", () => {
    const { repos } = svc.stats.get();
    expect(repos.map((r) => r.full_name)).toEqual(["me/alpha", "me/beta"]);

    const alpha = repos[0];
    expect(alpha.issues).toEqual({ open: 2, closed: 1 });
    // The merged PR's issues row is also state='closed'; it must count as merged
    // only, so closed captures closed-without-merge alone. Archived PRs in all
    // three states are excluded from these active-result counts.
    expect(alpha.pulls).toEqual({ open: 1, merged: 1, closed: 1 });

    const beta = repos[1];
    expect(beta.issues).toEqual({ open: 0, closed: 0 });
    expect(beta.pulls).toEqual({ open: 0, merged: 0, closed: 0 });
  });

  test("reports row counts for every user table", () => {
    const { tables } = svc.stats.get();
    const byName = new Map(tables.map((t) => [t.name, t.rows]));

    expect(byName.get("repos")).toBe(2);
    expect(byName.get("issues")).toBe(9); // 3 issues + 6 pulls
    expect(byName.get("pulls")).toBe(6);
    // Every user table from the schema appears, even empty ones; internal
    // sqlite_* tables do not.
    expect(byName.get("comments")).toBe(0);
    for (const t of tables) expect(t.name).not.toMatch(/^sqlite_/);
    // Name-ordered for a stable display.
    expect(tables.map((t) => t.name)).toEqual(
      [...tables.map((t) => t.name)].sort(),
    );
  });

  test("reports the DB file size including the WAL companion", () => {
    const { database } = svc.stats.get();
    expect(database.path).toBe(process.env.LOOPHUB_DB);
    expect(database.size_bytes).toBeGreaterThan(0);
    // journal_mode=WAL and writes above guarantee a -wal file exists here.
    expect(database.wal_size_bytes).toBeGreaterThan(0);
    expect(database.total_size_bytes).toBe(
      database.size_bytes + (database.wal_size_bytes ?? 0),
    );
  });

  // Runs last: it seeds an extra repo, which would shift the row-count
  // expectations of the earlier tests.
  test("counts a merged-then-reopened PR as merged only, not open", () => {
    const repo = S.createRepo("me/gamma", "/tmp/gamma");
    const pr = S.createIssue(repo.id, "pull", "reopened", "", "t");
    S.createPull(pr.id, "b", "main", null);
    S.setMerged(pr.id, "cafebabe", "squash");
    S.updateIssue(pr.id, { state: "open" });

    const { repos } = svc.stats.get();
    const gamma = repos.find((r) => r.full_name === "me/gamma");
    expect(gamma?.pulls).toEqual({ open: 0, merged: 1, closed: 0 });
  });
});
