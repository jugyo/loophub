import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB/HOME before importing any core module (db.ts opens at import time).
// github-pull-notifications.ts statically imports store → db, so it must be loaded only after
// LOOPHUB_* is set — a static import at the top of this file would open ~/.loophub/loophub.db.
const HOME = mkdtempSync(join(tmpdir(), "lh-github-pull-notify-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let notifyGithubPullLinked: typeof import("./github-pull-notifications.ts").notifyGithubPullLinked;
let S: typeof import("./store.ts");
let repoId: number;
let repoFullName: string;
let pullNumber: number;

beforeAll(async () => {
  ({ notifyGithubPullLinked } = await import("./github-pull-notifications.ts"));
  S = await import("./store.ts");
  repoFullName = `me/github-pull-notify-${Date.now()}`;
  const repo = S.createRepo(repoFullName, join(HOME, "repo"));
  repoId = repo.id;
  const pull = S.createIssue(repoId, "pull", "Exported PR", "", "me");
  S.createPull(pull.id, "feature", "main", "sha", null);
  pullNumber = pull.number;
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("links the notification to the loophub PR and de-dupes on the GitHub PR (#2506)", () => {
  const created = notifyGithubPullLinked({
    repoId,
    repoFullName,
    pullNumber,
    githubNumber: 42,
  });
  expect(created).toMatchObject({
    kind: "github_pr_linked",
    severity: "info",
    title: "GitHub PR created",
    body: `PR #${pullNumber} in ${repoFullName} is linked to GitHub PR #42.`,
    resource_kind: "pull",
    resource_number: pullNumber,
    source_key: `github-pr-linked:${repoId}:${pullNumber}:42`,
  });

  // Re-recording the same GitHub PR (a re-run, an overwrite, an unlink/re-link) stays silent.
  expect(
    notifyGithubPullLinked({
      repoId,
      repoFullName,
      pullNumber,
      githubNumber: 42,
    }),
  ).toBeNull();

  // A link corrected to a different GitHub PR is a new fact, so it notifies again.
  const corrected = notifyGithubPullLinked({
    repoId,
    repoFullName,
    pullNumber,
    githubNumber: 43,
  });
  expect(corrected?.source_key).toBe(
    `github-pr-linked:${repoId}:${pullNumber}:43`,
  );

  const unread = S.listNotifications({ unreadOnly: true }).filter(
    (n) => n.kind === "github_pr_linked",
  );
  expect(unread.map((n) => n.source_key)).toEqual([
    `github-pr-linked:${repoId}:${pullNumber}:43`,
    `github-pr-linked:${repoId}:${pullNumber}:42`,
  ]);
});

test("announces the notification so the topbar refreshes (#2506)", () => {
  const other = S.createIssue(repoId, "pull", "Another exported PR", "", "me");
  S.createPull(other.id, "feature-2", "main", "sha", null);
  const created = notifyGithubPullLinked({
    repoId,
    repoFullName,
    pullNumber: other.number,
    githubNumber: 7,
  });
  const event = S.listEvents(0, repoId, 100, undefined, "desc", {
    types: ["notification.created"],
  }).find((e) => JSON.parse(e.payload).id === created?.id);
  expect(event).toBeDefined();
  expect(JSON.parse(event!.payload)).toMatchObject({
    kind: "github_pr_linked",
    number: other.number,
  });
});
