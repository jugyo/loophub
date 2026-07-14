import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-panes-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  S.createRepo("me/panes", "/tmp/panes");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("a resource linked before pane registration resolves to the registered pane", () => {
  svc.herdrPanes.link({
    repo: "me/panes",
    launchId: "launch-link-first",
    resourceKind: "workflow_run",
    resourceKey: "42",
  });

  svc.herdrPanes.register({
    repo: "me/panes",
    launchId: "launch-link-first",
    paneId: "w1:p2",
    sessionName: "me-panes-12345678",
    displayName: "Workflow #42",
    origin: "workflow",
  });

  expect(
    svc.herdrPanes.listForResource({
      repo: "me/panes",
      resourceKind: "workflow_run",
      resourceKey: "42",
    }),
  ).toEqual([
    expect.objectContaining({
      launch_id: "launch-link-first",
      pane_id: "w1:p2",
      session_name: "me-panes-12345678",
      display_name: "Workflow #42",
      origin: "workflow",
    }),
  ]);
});

test("a registered pane can independently link to multiple resource kinds", () => {
  const registered = svc.herdrPanes.register({
    repo: "me/panes",
    launchId: "launch-register-first",
    paneId: "w2:p3",
    sessionName: "me-panes-12345678",
    displayName: "Build #8",
    origin: "build",
  });

  const issueLink = svc.herdrPanes.link({
    repo: "me/panes",
    launchId: "launch-register-first",
    resourceKind: "issue",
    resourceKey: "8",
  });
  svc.herdrPanes.link({
    repo: "me/panes",
    launchId: "launch-register-first",
    resourceKind: "pull",
    resourceKey: "11",
  });

  expect(issueLink.id).toBe(registered.id);
  expect(
    svc.herdrPanes.listForResource({
      repo: "me/panes",
      resourceKind: "issue",
      resourceKey: "8",
    }),
  ).toEqual([registered]);
  expect(
    svc.herdrPanes.listForResource({
      repo: "me/panes",
      resourceKind: "pull",
      resourceKey: "11",
    }),
  ).toEqual([registered]);
});

test("claims are idempotent and pane registration may arrive after the claim", () => {
  const first = svc.herdrPanes.claim({
    repo: "me/panes",
    launchId: "launch-claim-first",
    resourceKind: "issue",
    resourceKey: "21",
    purpose: "issue-create-lifecycle",
  });
  const second = svc.herdrPanes.claim({
    repo: "me/panes",
    launchId: "launch-claim-first",
    resourceKind: "issue",
    resourceKey: "21",
    purpose: "issue-create-lifecycle",
  });

  svc.herdrPanes.register({
    repo: "me/panes",
    launchId: "launch-claim-first",
    paneId: "w3:p4",
    sessionName: "me-panes-12345678",
    displayName: "New issue",
    origin: "issue-create",
    lifecycleManaged: true,
  });

  expect(second).toEqual(first);
  expect(
    svc.herdrPanes.claimsForResource({
      repo: "me/panes",
      resourceKind: "issue",
      resourceKey: "21",
    }),
  ).toEqual([
    expect.objectContaining({
      resource_kind: "issue",
      resource_key: "21",
      purpose: "issue-create-lifecycle",
      released_at: null,
    }),
  ]);
});

test("releasing the final active claim selects only lifecycle-managed panes", () => {
  for (const [launchId, issue] of [
    ["launch-shared", "31"],
    ["launch-shared", "32"],
  ] as const) {
    svc.herdrPanes.claim({
      repo: "me/panes",
      launchId,
      resourceKind: "issue",
      resourceKey: issue,
      purpose: "issue-create-lifecycle",
    });
  }
  svc.herdrPanes.register({
    repo: "me/panes",
    launchId: "launch-shared",
    paneId: "w4:p5",
    sessionName: "me-panes-12345678",
    displayName: "New issue",
    origin: "issue-create",
    lifecycleManaged: true,
  });

  expect(
    svc.herdrPanes.releaseClaimsForResource({
      repo: "me/panes",
      resourceKind: "issue",
      resourceKey: "31",
    }).closeCandidates,
  ).toEqual([]);
  expect(
    svc.herdrPanes.releaseClaimsForResource({
      repo: "me/panes",
      resourceKind: "issue",
      resourceKey: "32",
    }).closeCandidates,
  ).toEqual([
    expect.objectContaining({ launch_id: "launch-shared", pane_id: "w4:p5" }),
  ]);
  const repo = S.getRepo("me", "panes");
  const sharedPane = repo
    ? S.getHerdrPaneByLaunch(repo.id, "launch-shared")
    : null;
  if (!repo || !sharedPane) throw new Error("shared pane missing");
  S.addHerdrPaneClaim({
    repoId: repo.id,
    launchId: "launch-shared",
    resourceKind: "workflow_run",
    resourceKey: "41",
    purpose: "workflow-lifecycle",
  });
  expect(S.getHerdrPaneCloseCandidate(sharedPane.id)).toBeNull();

  svc.herdrPanes.register({
    repo: "me/panes",
    launchId: "launch-external",
    paneId: "w5:p6",
    sessionName: "external-session",
    displayName: "External",
    origin: "external",
    lifecycleManaged: false,
  });
  svc.herdrPanes.claim({
    repo: "me/panes",
    launchId: "launch-external",
    resourceKind: "issue",
    resourceKey: "33",
    purpose: "manual",
  });
  expect(
    svc.herdrPanes.releaseClaimsForResource({
      repo: "me/panes",
      resourceKind: "issue",
      resourceKey: "33",
    }).closeCandidates,
  ).toEqual([]);
});

test("repo deletion removes owned panes and their resource links", () => {
  const repo = S.createRepo("me/removable-panes", "/tmp/removable-panes");
  svc.herdrPanes.register({
    repo: repo.full_name,
    launchId: "launch-remove",
    paneId: "w9:p1",
    sessionName: "me-removable-panes-12345678",
    displayName: "Workflow #9",
    origin: "workflow",
  });
  svc.herdrPanes.link({
    repo: repo.full_name,
    launchId: "launch-remove",
    resourceKind: "workflow_run",
    resourceKey: "9",
  });

  expect(S.deleteRepo("me", "removable-panes")).toBe(true);
  expect(S.getHerdrPaneByLaunch(repo.id, "launch-remove")).toBeNull();
  expect(
    S.listHerdrPanesForResource({
      repoId: repo.id,
      resourceKind: "workflow_run",
      resourceKey: "9",
    }),
  ).toEqual([]);
});
