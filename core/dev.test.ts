import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-build-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let D: typeof import("./db.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

// Read a PR's primary dev-session attribution (derived from session_links, #316) by PR number.
function prSession(prNumber: number): string | null {
  const repoId = (S.getRepo("me", "proj") as { id: number }).id;
  const issueId = (S.getIssue(repoId, prNumber) as { id: number }).id;
  return S.primaryDevSessionForPull(issueId);
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
  D = await import("./db.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-build-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  git(["branch", "integration/stack"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-build", session: "sess-1" });
});

function poisonTargetBranch(issueNumber: number, targetBranch: string): void {
  const repo = S.getRepo("me", "proj");
  if (!repo) throw new Error("repo missing");
  const issue = S.getIssue(repo.id, issueNumber);
  if (!issue) throw new Error("issue missing");
  D.db.run("UPDATE issues SET target_branch = ? WHERE id = ?", [
    targetBranch,
    issue.id,
  ]);
}

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe("dev.openPr", () => {
  test("opens a draft PR linked to the issue, then is idempotent", async () => {
    const issue = svc.issues.create("me/proj", { title: "feature A" });
    expect(issue.number).toBe(1);

    // No explicit head: the PR's branch defaults to the PR-id convention (#463), derived from
    // the PR's own number once assigned — `lh build` relies on this default in production.
    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    expect(first.created).toBe(true);

    let pull = (await svc.pulls.get("me/proj", first.number)) as any;
    expect(pull.head.ref).toBe(`loophub/pr-${first.number}`);
    expect(pull.base.ref).toBe("main");
    // `lh build` opens the PR at the start of work, so it begins as a draft (#413).
    expect(pull.draft).toBe(true);
    expect(pull.linked_issue?.number).toBe(issue.number);
    expect(pull.body).toContain(`Closes #${issue.number}`);
    expect(pull.body).toContain("## 実装計画");
    expect(pull.body).toContain("source edit 前");
    expect(pull.body).toContain("変更予定ファイル/領域");
    expect(pull.body).toContain("再利用する既存 API/component/module");
    expect(pull.body).toContain("スコープ境界");
    expect(pull.body).toContain("更新・実行するテスト");
    expect(pull.body).toContain("**Visual evidence gate**: TODO");
    expect(
      S.getPull(S.getIssue(S.getRepo("me", "proj")!.id, first.number)!.id)
        ?.head_pending_creation,
    ).toBe(1);
    // The worktree path is copyable only after the directory exists; openPr runs before
    // provisioning, so a just-opened draft must not expose a stale/nonexistent path.
    const worktreePath = join(
      HOME,
      "worktrees",
      "me",
      "proj",
      `pr-${first.number}`,
    );
    expect(pull.worktree_path).toBeNull();
    mkdirSync(worktreePath, { recursive: true });
    pull = (await svc.pulls.get("me/proj", first.number)) as any;
    expect(pull.worktree_path).toBe(worktreePath);

    // Second call finds the existing open PR and does not create another.
    const second = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    expect(second.created).toBe(false);
    expect(second.number).toBe(first.number);
  });

  test("an explicit head overrides the PR-id convention", async () => {
    const issue = svc.issues.create("me/proj", { title: "explicit head" });
    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, head: "loophub/issue-custom", base: "main" },
      "sess-1",
    );
    const pull = (await svc.pulls.get("me/proj", first.number)) as any;
    expect(pull.head.ref).toBe("loophub/issue-custom");
  });

  test("parallel attempts inherit the first PR's recorded base SHA", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "parallel feature",
    });
    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    const firstPull = (await svc.pulls.get("me/proj", first.number)) as any;

    writeFileSync(join(repoPath, "parallel-later.txt"), "later\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "advance after first attempt"]);

    const second = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number },
      "sess-1",
      { parallel: true },
    );
    // Even if another opt-in caller creates a sibling with inconsistent metadata, later builds
    // inherit from the deterministic first attempt rather than an arbitrary open PR.
    const divergent = await svc.pulls.create(
      "me/proj",
      {
        title: "divergent proposal",
        head: "main",
        base: "main",
        issue: issue.number,
        parallel: true,
      },
      "sess-1",
    );
    const third = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number },
      "sess-1",
      { parallel: true },
    );
    const secondPull = (await svc.pulls.get("me/proj", second.number)) as any;
    const divergentPull = (await svc.pulls.get(
      "me/proj",
      divergent.number,
    )) as any;
    const thirdPull = (await svc.pulls.get("me/proj", third.number)) as any;

    expect(second.created).toBe(true);
    expect(third.created).toBe(true);
    expect(
      new Set([first.number, second.number, divergent.number, third.number])
        .size,
    ).toBe(4);
    expect(secondPull.base.ref).toBe(firstPull.base.ref);
    expect(secondPull.base_sha).toBe(firstPull.base_sha);
    expect(divergentPull.base_sha).not.toBe(firstPull.base_sha);
    expect(thirdPull.base_sha).toBe(firstPull.base_sha);

    // The default path remains idempotent even after several explicit attempts exist.
    const reuse = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number },
      "sess-1",
    );
    expect(reuse.created).toBe(false);
    expect([
      first.number,
      second.number,
      divergent.number,
      third.number,
    ]).toContain(reuse.number);
  });

  test("parallel attempts persist a merge-base fallback for a legacy PR", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "legacy parallel feature",
    });
    const legacyHead = `legacy-attempt-${issue.number}`;
    git(["branch", legacyHead]);
    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, head: legacyHead, base: "main" },
      "sess-1",
    );
    const repo = S.getRepo("me", "proj")!;
    const firstRow = S.getIssue(repo.id, first.number)!;
    const fallbackSha = ((await svc.pulls.get("me/proj", first.number)) as any)
      .base_sha;
    D.db.run("UPDATE pulls SET base_sha = NULL WHERE issue_id = ?", [
      firstRow.id,
    ]);

    writeFileSync(join(repoPath, "legacy-later.txt"), "later\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "advance after legacy attempt"]);

    const second = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number },
      "sess-1",
      { parallel: true },
    );
    const secondPull = (await svc.pulls.get("me/proj", second.number)) as any;
    expect(secondPull.base_sha).toBe(fallbackSha);
    expect(S.getPull(firstRow.id)?.base_sha).toBeNull();
  });

  test("reuses an existing PR without revalidating a stale target branch", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "reuse stale target",
      target_branch: "integration/stack",
    });
    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    git(["branch", "-D", "integration/stack"]);

    const second = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number },
      "sess-1",
    );

    expect(second).toEqual({ created: false, number: first.number });
    const pull = (await svc.pulls.get("me/proj", first.number)) as any;
    expect(pull.base.ref).toBe("main");
    git(["branch", "integration/stack"]);
  });

  test("uses the issue target branch as the draft PR base", async () => {
    const issueA = svc.issues.create("me/proj", {
      title: "stacked feature A",
      target_branch: "integration/stack",
    });
    const issueB = svc.issues.create("me/proj", {
      title: "stacked feature B",
      target_branch: "integration/stack",
    });

    const prA = await svc.dev.openPr(
      "me/proj",
      { issue: issueA.number },
      "sess-1",
    );
    const prB = await svc.dev.openPr(
      "me/proj",
      { issue: issueB.number },
      "sess-1",
    );

    const pullA = (await svc.pulls.get("me/proj", prA.number)) as any;
    const pullB = (await svc.pulls.get("me/proj", prB.number)) as any;
    expect(pullA.base.ref).toBe("integration/stack");
    expect(pullB.base.ref).toBe("integration/stack");
  });

  test("falls back to the repo default branch when the issue has no target branch", async () => {
    const issue = svc.issues.create("me/proj", { title: "default base" });

    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number },
      "sess-1",
    );

    const pull = (await svc.pulls.get("me/proj", pr.number)) as any;
    expect(pull.base.ref).toBe("main");
  });

  test("plain pulls.create defaults linked issue PRs to the issue target branch", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "direct pr base",
      target_branch: "integration/stack",
    });

    const pr = (await svc.pulls.create(
      "me/proj",
      {
        title: "direct impl",
        head: "main",
        issue: issue.number,
      },
      "sess-1",
    )) as any;

    expect(pr.base.ref).toBe("integration/stack");
  });

  test("dev.openPr rejects poisoned target branches when they are used", async () => {
    const issue = svc.issues.create("me/proj", { title: "poisoned build" });
    poisonTargetBranch(issue.number, "main~0");

    await expect(
      svc.dev.openPr("me/proj", { issue: issue.number }, "sess-1"),
    ).rejects.toThrow(/target_branch must name an existing local branch/);
  });

  test("dev.openPr explicit base bypasses a stale target branch", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "explicit base",
      target_branch: "integration/stack",
    });
    git(["branch", "-D", "integration/stack"]);

    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );

    const pull = (await svc.pulls.get("me/proj", pr.number)) as any;
    expect(pull.base.ref).toBe("main");
    git(["branch", "integration/stack"]);
  });

  test("dev.openPr rejects invalid explicit base refs", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "invalid explicit base",
    });

    await expect(
      svc.dev.openPr(
        "me/proj",
        { issue: issue.number, base: "main~0" },
        "sess-1",
      ),
    ).rejects.toThrow(/base must name an existing local branch/);
  });

  test("plain pulls.create rejects poisoned target branches when they are used", async () => {
    const issue = svc.issues.create("me/proj", { title: "poisoned direct" });
    poisonTargetBranch(issue.number, "main~0");

    await expect(
      svc.pulls.create(
        "me/proj",
        {
          title: "direct impl",
          head: "main",
          issue: issue.number,
        },
        "sess-1",
      ),
    ).rejects.toThrow(/target_branch must name an existing local branch/);
  });

  test("plain pulls.create rejects invalid explicit base refs", async () => {
    await expect(
      svc.pulls.create(
        "me/proj",
        {
          title: "bad explicit base",
          head: "main",
          base: "--help",
        },
        "sess-1",
      ),
    ).rejects.toThrow(/base must be a local branch name/);

    await expect(
      svc.pulls.create(
        "me/proj",
        {
          title: "revision explicit base",
          head: "main",
          base: "main~0",
        },
        "sess-1",
      ),
    ).rejects.toThrow(/base must name an existing local branch/);

    await expect(
      svc.pulls.create(
        "me/proj",
        {
          title: "control explicit base",
          head: "main",
          base: "main\nnext",
        },
        "sess-1",
      ),
    ).rejects.toThrow(/base must be a local branch name/);
  });

  test("attributes the session to the PR row and re-attaches on re-run", async () => {
    svc.sessions.register({
      id: "sess-a",
      agent: "lh-build",
      session: "sess-a",
    });
    svc.sessions.register({
      id: "sess-b",
      agent: "lh-build",
      session: "sess-b",
    });
    const issue = svc.issues.create("me/proj", { title: "feature B" });

    const first = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-a",
    );
    expect(first.created).toBe(true);
    expect(prSession(first.number)).toBe("sess-a");

    // Re-running with a fresh session reuses the open PR but re-points it (latest-writer-wins), so
    // `lh resume`/retro resolve the current session, not a stale one.
    const second = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-b",
    );
    expect(second.created).toBe(false);
    expect(prSession(second.number)).toBe("sess-b");
  });

  test("attributeSession: false skips re-pointing an existing PR's session (#463: deferred until the caller's dev lock is won)", async () => {
    svc.sessions.register({
      id: "sess-c",
      agent: "lh-build",
      session: "sess-c",
    });
    svc.sessions.register({
      id: "sess-d",
      agent: "lh-build",
      session: "sess-d",
    });
    const issue = svc.issues.create("me/proj", { title: "feature deferred" });

    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-c",
    );
    expect(prSession(first.number)).toBe("sess-c");

    // Re-running with attributeSession: false reuses the open PR but must NOT re-point its
    // session — the caller (lh build) hasn't won its PR-keyed dev lock yet at this point, and a
    // losing concurrent launch must never be allowed to overwrite the eventual winner's pointer.
    const second = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-d",
      { attributeSession: false },
    );
    expect(second.created).toBe(false);
    expect(second.number).toBe(first.number);
    expect(prSession(second.number)).toBe("sess-c"); // unchanged
  });

  test("soft guard: a second open PR is refused while one is open, and freed by closing the first", async () => {
    const issue = svc.issues.create("me/proj", { title: "feature C" });
    await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );
    // `lh build` is idempotent: re-opening reuses the existing PR rather than erroring.
    const reuse = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );
    expect(reuse.created).toBe(false);
    // The direct create path (e.g. `lh pr create --issue`) is soft-guarded: a second open PR for the
    // same issue is refused (422). This is a soft check, not a DB constraint — relaxable for the
    // future multi-proposal flow (#186).
    await expect(
      svc.pulls.create(
        "me/proj",
        {
          title: "rival",
          head: "rival-branch",
          base: "main",
          issue: issue.number,
        },
        "sess-1",
      ),
    ).rejects.toThrow(/already has an open pull request/);
    // The lower-level guard can only be bypassed by an explicit parallel proposal/attempt.
    const parallel = await svc.pulls.create(
      "me/proj",
      {
        title: "opt-in rival",
        head: "main",
        base: "main",
        issue: issue.number,
        parallel: true,
      },
      "sess-1",
    );
    expect(parallel.linked_issue?.number).toBe(issue.number);
    // Closing every open PR frees the slot so a fresh PR can be opened for the issue.
    svc.pulls.update("me/proj", reuse.number, { state: "closed" }, "sess-1");
    svc.pulls.update("me/proj", parallel.number, { state: "closed" }, "sess-1");
    const pr2 = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );
    expect(pr2.created).toBe(true);
    expect(pr2.number).not.toBe(reuse.number);
  });
});

describe("dev.resolveBuildPull", () => {
  test("returns the PR metadata needed to provision a build worktree", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "resolve build pull",
    });
    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    const stored = S.getPull(
      S.getIssue(S.getRepo("me", "proj")!.id, pr.number)!.id,
    )!;

    expect(svc.dev.resolveBuildPull("me/proj", pr.number)).toEqual({
      headRef: stored.head_ref,
      baseRef: stored.base_ref,
      headPendingCreation: true,
      baseSha: stored.base_sha,
    });
  });

  test.each([
    ["a missing number", 999_999],
    ["an issue number", null],
  ])("rejects %s as a missing pull request", (_label, number) => {
    const resolvedNumber =
      number ?? svc.issues.create("me/proj", { title: "not a pull" }).number;

    expect(() => svc.dev.resolveBuildPull("me/proj", resolvedNumber)).toThrow(
      `pull request #${resolvedNumber} not found`,
    );
  });

  test("rejects a pull issue whose pull row is missing", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "missing pull row",
    });
    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    const repo = S.getRepo("me", "proj")!;
    const prIssue = S.getIssue(repo.id, pr.number)!;
    D.db.run("DELETE FROM pulls WHERE issue_id = ?", [prIssue.id]);

    expect(() => svc.dev.resolveBuildPull("me/proj", pr.number)).toThrow(
      `pull request #${pr.number} not found`,
    );
  });
});

describe("dev.confirmProvisionedHead", () => {
  test("persists the provisioned branch SHA and clears pending creation", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "confirm provisioned head",
    });
    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    const repo = S.getRepo("me", "proj")!;
    const prIssue = S.getIssue(repo.id, pr.number)!;
    const headRef = S.getPull(prIssue.id)!.head_ref;
    git(["branch", headRef]);
    const expectedSha = spawnSync(
      "git",
      ["-C", repoPath, "rev-parse", headRef],
      { encoding: "utf8" },
    ).stdout.trim();

    await svc.dev.confirmProvisionedHead("me/proj", pr.number);

    expect(S.getPull(prIssue.id)).toMatchObject({
      head_sha: expectedSha,
      head_pending_creation: 0,
    });
  });

  test("fails explicitly and leaves pending state when the branch is unresolved", async () => {
    const issue = svc.issues.create("me/proj", {
      title: "unresolved provisioned head",
    });
    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, base: "main" },
      "sess-1",
    );
    const repo = S.getRepo("me", "proj")!;
    const prIssue = S.getIssue(repo.id, pr.number)!;
    const headRef = S.getPull(prIssue.id)!.head_ref;

    await expect(
      svc.dev.confirmProvisionedHead("me/proj", pr.number),
    ).rejects.toThrow(`could not resolve provisioned branch "${headRef}"`);
    expect(S.getPull(prIssue.id)).toMatchObject({
      head_sha: null,
      head_pending_creation: 1,
    });
  });
});

describe("dev.attachSession", () => {
  // #463: `lh build <issue>` defers session attribution for a reused PR from openPr to a later
  // attachSession call (after its dev lock is won). openPr's reuse branch used to emit
  // pull_request.updated on re-attribution so polling refreshes the PR detail's related-sessions list
  // refreshes; attachSession must emit the same event or that live-refresh silently regresses.
  test("re-points the session and emits pull_request.updated", async () => {
    svc.sessions.register({
      id: "sess-e",
      agent: "lh-build",
      session: "sess-e",
    });
    const pr = await svc.dev.openPr(
      "me/proj",
      {
        issue: svc.issues.create("me/proj", { title: "attach" }).number,
        base: "main",
      },
      "sess-e",
    );

    svc.sessions.register({
      id: "sess-f",
      agent: "lh-build",
      session: "sess-f",
    });
    svc.dev.attachSession("me/proj", pr.number, "sess-f");
    expect(prSession(pr.number)).toBe("sess-f");

    const events = svc.events.list({ repo: "me/proj", limit: 100 });
    const updated = events.find(
      (e) =>
        e.type === "pull_request.updated" &&
        (e.payload as any).number === pr.number,
    );
    expect(updated).toBeDefined();
  });
});

// #413: PR draft / ready lifecycle.
describe("pull draft / ready-for-review", () => {
  // Pull a PR's events (with payloads) out of the debug dump.
  async function prEvents(prNumber: number): Promise<any[]> {
    return ((await svc.pulls.debug("me/proj", prNumber)) as any).events;
  }

  test("dev.openPr opens a draft PR; pull_request.opened payload carries draft: true", async () => {
    const issue = svc.issues.create("me/proj", { title: "draft flow" });
    const { number } = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const pull = (await svc.pulls.get("me/proj", number)) as any;
    expect(pull.draft).toBe(true);

    const opened = (await prEvents(number)).find(
      (e) => e.type === "pull_request.opened",
    );
    expect(opened?.payload.draft).toBe(true);
  });

  test("plain pulls.create defaults to ready (draft: false)", async () => {
    const pr = (await svc.pulls.create(
      "me/proj",
      { title: "non-draft", head: "main", base: "main" },
      "sess-1",
    )) as any;
    expect(pr.draft).toBe(false);

    const opened = (await prEvents(pr.number)).find(
      (e) => e.type === "pull_request.opened",
    );
    expect(opened?.payload.draft).toBe(false);
  });

  test("readyForReview flips a draft PR to ready and fires pull_request.ready_for_review", async () => {
    const issue = svc.issues.create("me/proj", { title: "ready flow" });
    const { number } = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const after = (await svc.pulls.readyForReview(
      "me/proj",
      number,
      undefined,
      "sess-1",
    )) as any;
    expect(after.draft).toBe(false);

    const ready = (await prEvents(number)).find(
      (e) => e.type === "pull_request.ready_for_review",
    );
    expect(ready?.payload.draft).toBe(false);

    // Idempotent: a now-ready PR with no pending change requests can't be readied again.
    await expect(
      svc.pulls.readyForReview("me/proj", number, undefined, "sess-1"),
    ).rejects.toThrowError(/No pending change requests/);
  });
});
