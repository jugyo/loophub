import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const HOME = mkdtempSync(join(tmpdir(), "lh-conflict-coordinator-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let C: typeof import("./conflict-coordinator.ts");
let S: typeof import("../core/store.ts");

beforeAll(async () => {
  C = await import("./conflict-coordinator.ts");
  S = await import("../core/store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("同じ repository と base ref の実行中要求を coalesce する", async () => {
  let release!: () => void;
  const calls: Array<{ repoId: number; baseRef: string }> = [];
  const coordinator = C.createConflictCoordinator({
    sweep: async (target) => {
      calls.push(target);
      if (calls.length === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { checked: 1, emitted: 0 };
    },
  });
  const target = { repoId: 7, baseRef: "main", triggerEventId: 10 as const };
  const first = coordinator.enqueue(target);
  const second = coordinator.enqueue({ ...target, triggerEventId: 11 });

  expect(calls).toEqual([{ repoId: 7, baseRef: "main" }]);
  release();
  await expect(Promise.all([first, second])).resolves.toEqual([
    { checked: 1, emitted: 0 },
    { checked: 1, emitted: 0 },
  ]);
  expect(calls).toHaveLength(2);
});

test("local merge event だけが merged PR の base ref を enqueue する", async () => {
  const repo = S.createRepo("me/coordinator", HOME);
  const issue = S.createIssue(repo.id, "pull", "merged", "", "me");
  S.createPull(issue.id, "feature", "main", "head", null);
  const calls: Array<{ repoId: number; baseRef: string }> = [];
  const coordinator = C.createConflictCoordinator({
    sweep: async (target) => {
      calls.push(target);
      return { checked: 1, emitted: 0 };
    },
  });

  coordinator.enqueueMergedEvent(
    S.emitEvent(repo.id, "pull_request.merged", "me", {
      number: issue.number,
      sha: "merge-sha",
    }),
  );
  coordinator.enqueueMergedEvent(
    S.emitEvent(repo.id, "pull_request.merged", "me", {
      number: issue.number,
      github_number: 12,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(calls).toEqual([{ repoId: repo.id, baseRef: "main" }]);
});
