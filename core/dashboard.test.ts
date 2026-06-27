import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-dashboard-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-dashboard-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-dev", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe("dashboard.overview", () => {
  test("enriches each issue's linked PR like the dedicated issue list", async () => {
    const withPr = svc.issues.create("me/proj", { title: "has a PR" });
    await svc.dev.openPr(
      "me/proj",
      {
        issue: withPr.number,
        head: `loophub/issue-${withPr.number}`,
        base: "main",
      },
      "sess-1",
    );
    const noPr = svc.issues.create("me/proj", { title: "no PR" });

    const overview = await svc.dashboard.overview();
    const item = (n: number) =>
      overview.issues.find((i: any) => i.issue.number === n)?.issue;

    // The linked-PR issue carries the enriched array (Pattern E sub-rows), not
    // just the bare singular summary: the element exposes the status/diff fields
    // (mergeable_state, changed_files) that issueJSON's summary omits.
    const enriched = item(withPr.number);
    expect(Array.isArray(enriched.linked_pull_requests)).toBe(true);
    expect(enriched.linked_pull_requests).toHaveLength(1);
    expect(enriched.linked_pull_requests[0]).toHaveProperty("mergeable_state");
    expect(enriched.linked_pull_requests[0]).toHaveProperty("changed_files");
    expect(enriched.linked_pull_request?.number).toBe(
      enriched.linked_pull_requests[0].number,
    );

    // An issue with no linked PR stays a one-row item: empty array, null singular.
    const plain = item(noPr.number);
    expect(plain.linked_pull_requests).toEqual([]);
    expect(plain.linked_pull_request).toBeNull();
  });
});
