import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-issue-groups-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-issue-groups-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/groups" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("create / list / get a group, with member count", () => {
  const g = svc.issueGroups.create("me/groups", "sprint-1") as any;
  expect(g.id).toBeGreaterThan(0);
  expect(g.name).toBe("sprint-1");
  expect(g.members).toBe(0);

  const list = svc.issueGroups.list("me/groups") as any[];
  expect(list.map((x) => x.name)).toContain("sprint-1");

  const got = svc.issueGroups.get("me/groups", g.id) as any;
  expect(got.id).toBe(g.id);
  expect(got.name).toBe("sprint-1");
});

test("create trims the name and rejects blank or duplicate names", () => {
  const g = svc.issueGroups.create("me/groups", "  padded  ") as any;
  expect(g.name).toBe("padded");

  expect(() => svc.issueGroups.create("me/groups", "   ")).toThrow();
  expect(() => svc.issueGroups.create("me/groups", "padded")).toThrow();
});

test("rename a group; rejects collision with another group's name", () => {
  const a = svc.issueGroups.create("me/groups", "rename-a") as any;
  svc.issueGroups.create("me/groups", "rename-b");

  const renamed = svc.issueGroups.rename("me/groups", a.id, "rename-a2") as any;
  expect(renamed.name).toBe("rename-a2");

  // Renaming to the same name is allowed (no-op clash with itself).
  expect(svc.issueGroups.rename("me/groups", a.id, "rename-a2")).toBeTruthy();
  // Colliding with another group is rejected.
  expect(() => svc.issueGroups.rename("me/groups", a.id, "rename-b")).toThrow();
});

test("add / remove issues, ordered membership, idempotency", () => {
  const g = svc.issueGroups.create("me/groups", "ordered") as any;
  const i1 = svc.issues.create("me/groups", { title: "first" }) as any;
  const i2 = svc.issues.create("me/groups", { title: "second" }) as any;
  const i3 = svc.issues.create("me/groups", { title: "third" }) as any;

  svc.issueGroups.addIssue("me/groups", g.id, i1.number);
  svc.issueGroups.addIssue("me/groups", g.id, i2.number);
  svc.issueGroups.addIssue("me/groups", g.id, i3.number);

  const members = svc.issueGroups.members("me/groups", g.id) as any[];
  // Order is insertion order (position), not issue number order.
  expect(members.map((m) => m.number)).toEqual([
    i1.number,
    i2.number,
    i3.number,
  ]);

  // Re-adding is a no-op; count stays 3.
  svc.issueGroups.addIssue("me/groups", g.id, i1.number);
  expect((svc.issueGroups.get("me/groups", g.id) as any).members).toBe(3);

  // Remove the middle member; remaining order is preserved.
  svc.issueGroups.removeIssue("me/groups", g.id, i2.number);
  const after = svc.issueGroups.members("me/groups", g.id) as any[];
  expect(after.map((m) => m.number)).toEqual([i1.number, i3.number]);

  // Removing a non-member is a no-op.
  svc.issueGroups.removeIssue("me/groups", g.id, i2.number);
  expect((svc.issueGroups.get("me/groups", g.id) as any).members).toBe(2);
});

test("an issue can belong to multiple groups (many-to-many)", () => {
  const g1 = svc.issueGroups.create("me/groups", "m2m-1") as any;
  const g2 = svc.issueGroups.create("me/groups", "m2m-2") as any;
  const issue = svc.issues.create("me/groups", { title: "shared" }) as any;

  svc.issueGroups.addIssue("me/groups", g1.id, issue.number);
  svc.issueGroups.addIssue("me/groups", g2.id, issue.number);

  expect(
    (svc.issueGroups.members("me/groups", g1.id) as any[]).map((m) => m.number),
  ).toContain(issue.number);
  expect(
    (svc.issueGroups.members("me/groups", g2.id) as any[]).map((m) => m.number),
  ).toContain(issue.number);
});

test("delete a group removes memberships but leaves the issues intact", () => {
  const g = svc.issueGroups.create("me/groups", "to-delete") as any;
  const issue = svc.issues.create("me/groups", { title: "survivor" }) as any;
  svc.issueGroups.addIssue("me/groups", g.id, issue.number);

  const res = svc.issueGroups.remove("me/groups", g.id) as any;
  expect(res.deleted).toBe(true);

  // Group is gone...
  expect(() => svc.issueGroups.get("me/groups", g.id)).toThrow();
  // ...but the issue still exists.
  const still = svc.issues.get("me/groups", issue.number) as any;
  expect(still.title).toBe("survivor");
});

test("404 on unknown group; 404 when adding a non-issue / missing issue", () => {
  expect(() => svc.issueGroups.get("me/groups", 999999)).toThrow();

  const g = svc.issueGroups.create("me/groups", "guards") as any;
  expect(() => svc.issueGroups.addIssue("me/groups", g.id, 999999)).toThrow();
});

test("groups are scoped per repo", async () => {
  const other = mkdtempSync(join(tmpdir(), "lh-issue-groups-other-"));
  spawnSync("git", ["-C", other, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", other, "config", "user.email", "t@t.local"]);
  spawnSync("git", ["-C", other, "config", "user.name", "tester"]);
  writeFileSync(join(other, "a.txt"), "y\n");
  spawnSync("git", ["-C", other, "add", "-A"]);
  spawnSync("git", ["-C", other, "commit", "-qm", "init"]);
  await svc.repos.create({ path: other, name: "me/other" });

  svc.issueGroups.create("me/other", "only-in-other");
  const names = (svc.issueGroups.list("me/groups") as any[]).map((g) => g.name);
  expect(names).not.toContain("only-in-other");

  rmSync(other, { recursive: true, force: true });
});

test("removing a repo with a populated group does not fail on foreign keys", async () => {
  const rmPath = mkdtempSync(join(tmpdir(), "lh-issue-groups-rm-"));
  spawnSync("git", ["-C", rmPath, "init", "-q", "-b", "main"]);
  spawnSync("git", ["-C", rmPath, "config", "user.email", "t@t.local"]);
  spawnSync("git", ["-C", rmPath, "config", "user.name", "tester"]);
  writeFileSync(join(rmPath, "a.txt"), "z\n");
  spawnSync("git", ["-C", rmPath, "add", "-A"]);
  spawnSync("git", ["-C", rmPath, "commit", "-qm", "init"]);
  await svc.repos.create({ path: rmPath, name: "me/removable" });

  // A group with a member exercises both FK edges (member->issues, group->repos).
  const g = svc.issueGroups.create("me/removable", "g") as any;
  const issue = svc.issues.create("me/removable", { title: "x" }) as any;
  svc.issueGroups.addIssue("me/removable", g.id, issue.number);

  // foreign_keys=ON: this throws before the deleteRepo sweep was added.
  expect(() => svc.repos.remove("me/removable")).not.toThrow();
  expect(() => svc.repos.get("me/removable")).toThrow();

  rmSync(rmPath, { recursive: true, force: true });
});
