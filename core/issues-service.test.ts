import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-issue-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let D: typeof import("./db.ts");
let repoPath: string;

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  D = await import("./db.ts");
  repoPath = mkdtempSync(join(tmpdir(), "lh-issue-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["branch", "integration/stack"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("issues.get returns comment bodies in comment_list (#231)", async () => {
  const issue = svc.issues.create("me/proj", { title: "t", body: "body" });
  svc.comments.create("me/proj", issue.number, "first design note", "sess-a");
  svc.comments.create("me/proj", issue.number, "second design note", "sess-b");

  const detail = (await svc.issues.get("me/proj", issue.number)) as any;

  // Count stays for the cheap summary surface...
  expect(detail.comments).toBe(2);
  // ...and the detail also carries the full bodies (author, time, text). Assert membership, not
  // order: comments created within the same second share a `created_at` (now() drops sub-second
  // precision) and listComments orders by created_at with no tiebreaker, so order is not guaranteed.
  expect(detail.comment_list).toHaveLength(2);
  expect(detail.comment_list.map((c: any) => c.body)).toEqual(
    expect.arrayContaining(["first design note", "second design note"]),
  );
  const [c0] = detail.comment_list;
  expect(c0.user.login).toBeTruthy();
  expect(c0.created_at).toBeTruthy();
});

test("issues.get returns an empty comment_list when there are no comments", async () => {
  const issue = svc.issues.create("me/proj", { title: "no comments" });
  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
  expect(detail.comments).toBe(0);
  expect(detail.comment_list).toEqual([]);
});

test("issues.get reports no open pull request for a PR-less issue", async () => {
  const issue = svc.issues.create("me/proj", { title: "no pull request" });
  const detail = await svc.issues.get("me/proj", issue.number);

  expect(detail.linked_pull_requests).toEqual([]);
  expect(detail.has_open_pull_request).toBe(false);
});

test("issues.get reports an open linked pull request", async () => {
  const issue = svc.issues.create("me/proj", { title: "open pull request" });
  git(["branch", "feature/open-pull-request"]);
  await svc.pulls.create("me/proj", {
    title: "open pull request",
    head: "feature/open-pull-request",
    issue: issue.number,
  });

  const detail = await svc.issues.get("me/proj", issue.number);

  expect(detail.linked_pull_requests).toHaveLength(1);
  expect(detail.has_open_pull_request).toBe(true);
});

test("issues.create stores and exposes a target branch", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "branch-targeted",
    target_branch: "integration/stack",
  }) as any;

  expect(issue.target_branch).toBe("integration/stack");
  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
  expect(detail.target_branch).toBe("integration/stack");
});

test("issues.create stores an active registered workspace as the target branch", () => {
  svc.workspaces.create("me/proj", { branch: "workspace/active" });

  const issue = svc.issues.create("me/proj", {
    title: "workspace target",
    workspace: "workspace/active",
  }) as any;

  expect(issue.target_branch).toBe("workspace/active");
});

test("issues.update moves an issue between workspaces and emits an update event", () => {
  svc.workspaces.create("me/proj", { branch: "workspace/update" });
  const issue = svc.issues.create("me/proj", { title: "movable" }) as any;

  const updated = svc.issues.update("me/proj", issue.number, {
    workspace: "workspace/update",
  }) as any;

  expect(updated.target_branch).toBe("workspace/update");
  const event = S.listEvents(0, S.getRepo("me", "proj")!.id, 100)
    .filter((e) => e.type === "issue.updated")
    .at(-1);
  expect(event && JSON.parse(event.payload)).toEqual({ number: issue.number });
});

test("issues.update clears a workspace without changing an existing PR base", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "linked movable",
    target_branch: "integration/stack",
  }) as any;
  git(["branch", "feature/linked-movable"]);
  const pull = (await svc.pulls.create("me/proj", {
    title: "linked pull",
    head: "feature/linked-movable",
    issue: issue.number,
  })) as any;
  const repo = S.getRepo("me", "proj")!;
  const before = S.getPull(S.getIssue(repo.id, pull.number)!.id)!.base_ref;

  const updated = svc.issues.update("me/proj", issue.number, {
    target_branch: null,
  }) as any;

  expect(updated.target_branch).toBeNull();
  expect(S.getPull(S.getIssue(repo.id, pull.number)!.id)!.base_ref).toBe(
    before,
  );
});

test("issues.update rejects target branch changes for pull rows", async () => {
  git(["branch", "feature/pull-update"]);
  const pull = (await svc.pulls.create("me/proj", {
    title: "plain pull",
    head: "feature/pull-update",
    base: "main",
  })) as any;

  expect(() =>
    svc.issues.update("me/proj", pull.number, {
      target_branch: "integration/stack",
    }),
  ).toThrow(/cannot be changed for a pull/);
});

test("issues.create rejects a blank workspace", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "blank workspace",
      workspace: "   ",
    }),
  ).toThrow(/workspace branch is required/);
});

test("issues.create rejects unregistered, archived, and missing workspace branches", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "unregistered workspace",
      workspace: "workspace/unregistered",
    }),
  ).toThrow(/active registered workspace/);

  svc.workspaces.create("me/proj", { branch: "workspace/archived" });
  svc.workspaces.archive("me/proj", "workspace/archived");
  expect(() =>
    svc.issues.create("me/proj", {
      title: "archived workspace",
      workspace: "workspace/archived",
    }),
  ).toThrow(/active registered workspace/);

  svc.workspaces.create("me/proj", { branch: "workspace/missing" });
  git(["branch", "-D", "workspace/missing"]);
  expect(() =>
    svc.issues.create("me/proj", {
      title: "missing workspace branch",
      workspace: "workspace/missing",
    }),
  ).toThrow(/workspace branch must exist locally/);
});

test("issues.create rejects workspace with a target branch", () => {
  svc.workspaces.create("me/proj", { branch: "workspace/conflict" });

  expect(() =>
    svc.issues.create("me/proj", {
      title: "target conflict",
      workspace: "workspace/conflict",
      target_branch: "integration/stack",
    }),
  ).toThrow(/workspace cannot be combined with target_branch/);
});

test("issues.create normalizes a blank target branch to null", () => {
  const issue = svc.issues.create("me/proj", {
    title: "blank target",
    target_branch: "   ",
  }) as any;

  expect(issue.target_branch).toBeNull();
});

test("issues.create without a target branch does not create a branch", () => {
  const before = git([
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/new/topic",
  ]);
  expect(before.status).not.toBe(0);

  const issue = svc.issues.create("me/proj", {
    title: "untargeted",
  }) as any;

  expect(issue.target_branch).toBeNull();
  const after = git([
    "show-ref",
    "--verify",
    "--quiet",
    "refs/heads/new/topic",
  ]);
  expect(after.status).not.toBe(0);
});

test("issues.create rejects a missing target branch", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "missing target",
      target_branch: "missing/stack",
    }),
  ).toThrow(/target_branch must name an existing local branch/);
});

test("issues.create rejects option-like target branches", () => {
  expect(() =>
    svc.issues.create("me/proj", {
      title: "option target",
      target_branch: "--output=/tmp/lh-target-branch",
    }),
  ).toThrow(/target_branch must be a local branch name/);
});

test("issues.create rejects revision-special target branch names", () => {
  git(["branch", "@"]);

  expect(() =>
    svc.issues.create("me/proj", {
      title: "special target",
      target_branch: "@",
    }),
  ).toThrow(/target_branch must be a local branch name/);
});

test("issues.list defaults to newest-created order and keeps label filters (#751)", async () => {
  const repo = S.createRepo("me/list-default-sort", "/tmp/list-default-sort");
  const oldIssue = S.createIssue(
    repo.id,
    "issue",
    "old labeled",
    "",
    "me",
  ) as any;
  const newIssue = S.createIssue(
    repo.id,
    "issue",
    "new labeled",
    "",
    "me",
  ) as any;
  const newestUnlabeled = S.createIssue(
    repo.id,
    "issue",
    "newest unlabeled",
    "",
    "me",
  ) as any;
  const setTimes = (id: number, created: string, updated: string) =>
    D.db.run("UPDATE issues SET created_at = ?, updated_at = ? WHERE id = ?", [
      created,
      updated,
      id,
    ]);

  setTimes(oldIssue.id, "2026-01-01T00:00:00Z", "2026-06-01T00:00:00Z");
  setTimes(newIssue.id, "2026-02-01T00:00:00Z", "2026-02-01T00:00:00Z");
  setTimes(newestUnlabeled.id, "2026-03-01T00:00:00Z", "2026-03-01T00:00:00Z");
  S.addLabels(repo.id, oldIssue.id, ["ready-to-build"]);
  S.addLabels(repo.id, newIssue.id, ["ready-to-build"]);

  const defaults = (await svc.issues.list("me/list-default-sort", {
    kind: "issue",
    state: "open",
  })) as any[];
  const filtered = (await svc.issues.list("me/list-default-sort", {
    kind: "issue",
    state: "open",
    labels: ["ready-to-build"],
  })) as any[];
  const updated = (await svc.issues.list("me/list-default-sort", {
    kind: "issue",
    state: "open",
    sort: "updated",
  })) as any[];

  expect(defaults.map((issue) => issue.title)).toEqual([
    "newest unlabeled",
    "new labeled",
    "old labeled",
  ]);
  expect(filtered.map((issue) => issue.title)).toEqual([
    "new labeled",
    "old labeled",
  ]);
  expect(updated.map((issue) => issue.title)).toEqual([
    "old labeled",
    "newest unlabeled",
    "new labeled",
  ]);
});

test("issues.list advances lookahead pages by the visible issue-list size (#906)", async () => {
  const repo = S.createRepo("me/list-lookahead", "/tmp/list-lookahead");
  for (let i = 1; i <= 201; i += 1) {
    S.createIssue(repo.id, "issue", `lookahead ${i}`, "", "me");
  }

  const page1 = (await svc.issues.list("me/list-lookahead", {
    kind: "issue",
    state: "open",
    perPage: 101,
    page: 1,
  })) as any[];
  const page2 = (await svc.issues.list("me/list-lookahead", {
    kind: "issue",
    state: "open",
    perPage: 101,
    page: 2,
  })) as any[];
  const page3 = (await svc.issues.list("me/list-lookahead", {
    kind: "issue",
    state: "open",
    perPage: 101,
    page: 3,
  })) as any[];

  expect(page1).toHaveLength(101);
  expect(page2).toHaveLength(101);
  expect(page3).toHaveLength(1);
});

test("issues.list applies the workspace filter before pagination", async () => {
  const repo = S.createRepo("me/list-workspace", "/tmp/list-workspace");
  S.createIssue(repo.id, "issue", "feature 1", "", "me", "feature/a");
  S.createIssue(repo.id, "issue", "other 1", "", "me", "feature/b");
  S.createIssue(repo.id, "issue", "feature 2", "", "me", "feature/a");
  S.createIssue(repo.id, "issue", "default explicit", "", "me", "main");
  S.createIssue(repo.id, "issue", "feature 3", "", "me", "feature/a");
  S.createIssue(repo.id, "issue", "default implicit", "", "me");

  const firstPage = (await svc.issues.list("me/list-workspace", {
    kind: "issue",
    workspace: "feature/a",
    lookahead: true,
    perPage: 3,
    page: 1,
  })) as any[];
  const secondPage = (await svc.issues.list("me/list-workspace", {
    kind: "issue",
    workspace: "feature/a",
    lookahead: true,
    perPage: 3,
    page: 2,
  })) as any[];
  const defaultWorkspace = (await svc.issues.list("me/list-workspace", {
    kind: "issue",
    workspace: "main",
  })) as any[];

  expect(firstPage.map((issue) => issue.title)).toEqual([
    "feature 3",
    "feature 2",
    "feature 1",
  ]);
  expect(secondPage.map((issue) => issue.title)).toEqual(["feature 1"]);
  expect(defaultWorkspace.map((issue) => issue.title)).toEqual([
    "default implicit",
    "default explicit",
  ]);
});

test("issues.create links and claims the explicit current Herdr pane before emitting issue.opened", async () => {
  const repo = S.getRepo("me", "proj");
  if (!repo) throw new Error("repo missing");
  S.registerHerdrPane({
    launchId: "workflow-launch",
    repoId: repo.id,
    paneId: "w4:p2",
    sessionName: "workflow-session",
    displayName: "Workflow #50",
    origin: "workflow",
  });
  const originalEmitEvent = S.emitEvent;
  const emitEvent = vi.spyOn(S, "emitEvent").mockImplementation((...args) => {
    const payload = args[3] as { number: number };
    const created = S.getIssue(repo.id, payload.number);
    if (!created) throw new Error("issue missing before event");
    expect(S.getIssueHerdrPane(created.id)?.launch_id).toBe("workflow-launch");
    expect(
      S.listHerdrPaneClaimsForResource({
        repoId: repo.id,
        resourceKind: "issue",
        resourceKey: String(created.id),
      }),
    ).toEqual([
      expect.objectContaining({
        purpose: "issue-create-lifecycle",
        released_at: null,
      }),
    ]);
    return originalEmitEvent(...args);
  });
  try {
    const issue = svc.issues.create(
      "me/proj",
      { title: "from workflow" },
      undefined,
      { paneId: "w4:p2", sessionName: "workflow-session" },
    );

    const detail = (await svc.issues.get("me/proj", issue.number)) as any;
    expect(detail.herdr_pane).toMatchObject({
      launch_id: "workflow-launch",
      pane_id: "w4:p2",
      session_name: "workflow-session",
    });
    expect(S.getHerdrPaneByLaunch(repo.id, "workflow-launch")?.origin).toBe(
      "workflow",
    );

    const list = (await svc.issues.list("me/proj", {
      kind: "issue",
      state: "open",
    })) as any[];
    expect(
      list.find((item) => item.number === issue.number)?.herdr_pane,
    ).toMatchObject({
      launch_id: "workflow-launch",
      pane_id: "w4:p2",
      session_name: "workflow-session",
    });
  } finally {
    emitEvent.mockRestore();
  }
});

test("issues.create does not read New Issue launch context from process.env", async () => {
  const repo = S.getRepo("me", "proj");
  if (!repo) throw new Error("repo missing");
  const key = "LOOPHUB_ISSUE_CREATE_HERDR_LAUNCH";
  const previous = process.env[key];
  process.env[key] = "must-stay-in-cli";
  try {
    const issue = svc.issues.create("me/proj", { title: "outside Herdr" });
    const row = S.getIssue(repo.id, issue.number);
    if (!row) throw new Error("issue missing");
    expect(S.getIssueHerdrPane(row.id)).toBeNull();
    expect(
      S.listHerdrPaneClaimsForResource({
        repoId: repo.id,
        resourceKind: "issue",
        resourceKey: String(row.id),
      }),
    ).toEqual([]);
    expect(
      (await svc.issues.get("me/proj", issue.number)).herdr_pane,
    ).toBeNull();
  } finally {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
});

test("New Issue launch lookup is scoped to its repository", () => {
  const firstRepo = S.getRepo("me", "proj");
  if (!firstRepo) throw new Error("repo missing");
  const secondRepo = S.createRepo("me/other-panes", "/tmp/other-panes");

  S.upsertIssueHerdrPane({
    launchId: "shared-launch",
    repoId: firstRepo.id,
    paneId: "w1:p1",
  });
  S.upsertIssueHerdrPane({
    launchId: "shared-launch",
    repoId: secondRepo.id,
    paneId: "w2:p2",
  });

  expect(S.getHerdrPaneByLaunch(secondRepo.id, "shared-launch")?.pane_id).toBe(
    "w2:p2",
  );
});

test("issues.create seeds structured acceptance criteria and issues.get returns enabled ones (#1894)", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "with criteria",
    acceptance_criteria: ["first", "  ", "second"],
  }) as any;

  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
  // Blank entries are dropped; the wire carries stable identity and issue-local number.
  expect(detail.acceptance_criteria).toHaveLength(2);
  expect(detail.acceptance_criteria.map((c: any) => c.text)).toEqual([
    "first",
    "second",
  ]);
  const [c0] = detail.acceptance_criteria;
  expect(Object.keys(c0).sort()).toEqual(["id", "number", "ordinal", "text"]);
  expect(c0.id).toBeGreaterThan(0);
  expect(detail.acceptance_criteria.map((c: any) => c.number)).toEqual([1, 2]);
});

test("issues.get omits disabled acceptance criteria from the rubric (#1894)", async () => {
  const issue = svc.issues.create("me/proj", {
    title: "disable one",
    acceptance_criteria: ["keep", "drop"],
  }) as any;
  const list = svc.issues.acList("me/proj", issue.number) as any[];
  const toDisable = list.find((c) => c.text === "drop")!;

  const disabled = svc.issues.acSetEnabled(
    "me/proj",
    toDisable.id,
    false,
  ) as any;
  expect(disabled.enabled).toBe(false);

  const detail = (await svc.issues.get("me/proj", issue.number)) as any;
  expect(detail.acceptance_criteria.map((c: any) => c.text)).toEqual(["keep"]);
  // The disabled row still exists in the authoring list — it is not deleted.
  const after = svc.issues.acList("me/proj", issue.number) as any[];
  expect(after).toHaveLength(2);
  expect(after.find((c) => c.text === "drop")!.enabled).toBe(false);
});

test("issues.ac add appends with a fresh id at the end and can be re-enabled (#1894)", () => {
  const issue = svc.issues.create("me/proj", { title: "ac add" }) as any;
  const a = svc.issues.acAdd("me/proj", issue.number, "alpha") as any;
  const b = svc.issues.acAdd("me/proj", issue.number, "  beta  ") as any;

  expect(b.text).toBe("beta");
  expect(b.id).not.toBe(a.id);
  expect([a.number, b.number]).toEqual([1, 2]);
  expect(b.ordinal).toBeGreaterThan(a.ordinal);

  svc.issues.acSetEnabled("me/proj", a.id, false);
  const reenabled = svc.issues.acSetEnabled("me/proj", a.id, true) as any;
  expect(reenabled.id).toBe(a.id);
  expect(reenabled.enabled).toBe(true);
});

test("AC numbers remain stable across disable, re-enable, reorder, and append", () => {
  const issue = svc.issues.create("me/proj", {
    title: "stable numbers",
    acceptance_criteria: ["one", "two"],
  }) as any;
  const [one, two] = svc.issues.acList("me/proj", issue.number) as any[];

  svc.issues.acSetEnabled("me/proj", "ac-1", false, issue.number);
  svc.issues.acSetEnabled("me/proj", "ac-1", true, issue.number);
  const reordered = svc.issues.acReorder("me/proj", issue.number, [
    "ac-2",
    "ac-1",
  ]) as any[];
  const three = svc.issues.acAdd("me/proj", issue.number, "three") as any;

  expect(reordered.map((c) => [c.id, c.number])).toEqual([
    [two.id, 2],
    [one.id, 1],
  ]);
  expect(three.number).toBe(3);
});

test("issue-scoped AC references reject malformed and missing numbers", () => {
  const issue = svc.issues.create("me/proj", {
    title: "strict refs",
    acceptance_criteria: ["one"],
  }) as any;
  expect(() =>
    svc.issues.acSetEnabled("me/proj", "ac-0", false, issue.number),
  ).toThrow(/must be a stable id or ac-<number>/);
  expect(() =>
    svc.issues.acSetEnabled("me/proj", "ac-2", false, issue.number),
  ).toThrow(/not found/);
});

test("issues.acAdd rejects blank text", () => {
  const issue = svc.issues.create("me/proj", { title: "blank ac" }) as any;
  expect(() => svc.issues.acAdd("me/proj", issue.number, "   ")).toThrow(
    /text is required/,
  );
});

test("issues.acReorder rewrites ordinal but keeps criterion ids stable (#1894)", () => {
  const issue = svc.issues.create("me/proj", {
    title: "reorder",
    acceptance_criteria: ["one", "two", "three"],
  }) as any;
  const before = svc.issues.acList("me/proj", issue.number) as any[];
  const [one, two, three] = before;

  const after = svc.issues.acReorder("me/proj", issue.number, [
    three.id,
    one.id,
    two.id,
  ]) as any[];

  // Identity is unchanged; only position (ordinal) moved.
  expect(after.map((c) => c.text)).toEqual(["three", "one", "two"]);
  expect(after.map((c) => c.id)).toEqual([three.id, one.id, two.id]);
  expect(after.map((c) => c.ordinal)).toEqual([1, 2, 3]);
});

test("issues.acReorder rejects an order that is not a full permutation", () => {
  const issue = svc.issues.create("me/proj", {
    title: "bad reorder",
    acceptance_criteria: ["x", "y"],
  }) as any;
  const [x] = svc.issues.acList("me/proj", issue.number) as any[];
  expect(() => svc.issues.acReorder("me/proj", issue.number, [x.id])).toThrow(
    /every acceptance criterion id/,
  );
});

test("issues.acSetEnabled 404s for a criterion outside the repo (#1894)", () => {
  const other = S.createRepo("me/ac-scope", "/tmp/ac-scope");
  const foreign = S.createIssue(other.id, "issue", "foreign", "", "me") as any;
  const criterion = S.addAcceptanceCriterion(foreign.id, "foreign ac");
  expect(() => svc.issues.acSetEnabled("me/proj", criterion.id, false)).toThrow(
    /not found/,
  );
});

test("issues service exposes no acceptance-criterion delete (#1894)", () => {
  // disable is the only retirement path; a delete method would let a grade FK dangle.
  expect((svc.issues as any).acDelete).toBeUndefined();
  expect((svc.issues as any).acRemove).toBeUndefined();
});

test("repos.remove removes Herdr pane links even when issue_id is not assigned yet", () => {
  const repo = S.getRepo("me", "proj");
  if (!repo) throw new Error("repo missing");
  S.upsertIssueHerdrPane({
    launchId: "launch-no-issue",
    repoId: repo.id,
    paneId: "w4:p9",
    sessionName: "me-proj-no-issue",
  });

  svc.repos.remove("me/proj");

  expect(S.getRepo("me", "proj")).toBeNull();
});
