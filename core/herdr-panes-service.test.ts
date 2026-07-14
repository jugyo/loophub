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
