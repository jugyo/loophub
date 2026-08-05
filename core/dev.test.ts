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
const CLI = join(import.meta.dirname, "..", "cli", "index.ts");

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
    expect(pull.linked_issue?.number).toBe(issue.number);
    expect(pull.body).toContain(`Closes #${issue.number}`);
    expect(pull.body).toContain("## Implementation plan");
    expect(pull.body).not.toContain("## 実装計画");
    expect(pull.body).toContain("ソース編集前");
    expect(pull.body).toContain("変更予定ファイル/領域");
    expect(pull.body).toContain("再利用する既存 API/component/module");
    expect(pull.body).toContain("スコープ境界");
    expect(pull.body).toContain("更新・実行するテスト");
    expect(pull.body).toContain("## Evidence");
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

  test("uses the workspace environment from issue creation as the build PR base", async () => {
    const created = spawnSync(
      process.execPath,
      [
        "--experimental-sqlite",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        CLI,
        "issue",
        "create",
        "--repo",
        "me/proj",
        "--title",
        "workspace environment build",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPHUB_HOME: HOME,
          LOOPHUB_DB: join(HOME, "test.db"),
          LOOPHUB_WORKSPACE: "integration/stack",
        },
      },
    );
    expect(created.status, created.stderr).toBe(0);
    const match = created.stdout.match(/created #(\d+)/);
    if (!match) throw new Error(`create failed: ${created.stdout}`);

    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: Number(match[1]) },
      "sess-1",
    );
    const pull = (await svc.pulls.get("me/proj", pr.number)) as any;
    expect(pull.base.ref).toBe("integration/stack");
  });

  test("uses an explicitly selected registered workspace as the build PR base", async () => {
    svc.workspaces.create("me/proj", { branch: "workspace/explicit" });
    const created = spawnSync(
      process.execPath,
      [
        "--experimental-sqlite",
        "--disable-warning=ExperimentalWarning",
        "--import",
        "tsx",
        CLI,
        "issue",
        "create",
        "--repo",
        "me/proj",
        "--title",
        "explicit workspace build",
        "--workspace",
        "workspace/explicit",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          LOOPHUB_HOME: HOME,
          LOOPHUB_DB: join(HOME, "test.db"),
        },
      },
    );
    expect(created.status, created.stderr).toBe(0);
    const match = created.stdout.match(/created #(\d+)/);
    if (!match) throw new Error(`create failed: ${created.stdout}`);

    const pr = await svc.dev.openPr(
      "me/proj",
      { issue: Number(match[1]) },
      "sess-1",
    );
    const pull = (await svc.pulls.get("me/proj", pr.number)) as any;
    expect(pull.base.ref).toBe("workspace/explicit");
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
    // Usage attribution and retro resolve the current session, not a stale one.
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
    // same issue is refused (422).
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
    // Closing the open PR frees the slot so a fresh PR can be opened for the issue.
    svc.pulls.update("me/proj", reuse.number, { state: "closed" }, "sess-1");
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

describe("pull review state", () => {
  test("stays CHANGES_REQUESTED until a later review verdict", async () => {
    const pr = await svc.pulls.create(
      "me/proj",
      { title: "review state", head: "main", base: "main" },
      "sess-1",
    );
    await svc.reviews.create(
      "me/proj",
      pr.number,
      { event: "REQUEST_CHANGES", body: "needs changes" },
      "sess-1",
    );

    expect((await svc.pulls.get("me/proj", pr.number)).review_state).toBe(
      "CHANGES_REQUESTED",
    );
    const repo = S.getRepo("me", "proj")!;
    const row = S.getIssue(repo.id, pr.number)!;
    D.db.run(
      "UPDATE pulls SET changes_addressed_at = ?, changes_addressed_by = ? WHERE issue_id = ?",
      ["2026-07-29T00:00:00Z", "legacy-agent", row.id],
    );
    expect((await svc.pulls.get("me/proj", pr.number)).review_state).toBe(
      "CHANGES_REQUESTED",
    );
    await svc.reviews.create(
      "me/proj",
      pr.number,
      { event: "PASS", body: "fixed" },
      "sess-1",
    );
    expect((await svc.pulls.get("me/proj", pr.number)).review_state).toBe(
      "PASSED",
    );
  });

  // A review carries how long it took (#2387), grounded in the agent session that submitted it. A
  // submission with no registered session records none and reports no duration.
  test("reports the submitting agent session's elapsed time as the review duration", async () => {
    const pr = await svc.pulls.create(
      "me/proj",
      { title: "review duration", head: "main", base: "main" },
      "sess-1",
    );
    svc.sessions.register({
      id: "sess-verify",
      agent: "verifier",
      session: "sess-verify",
    });
    S.setAgentSessionCreatedAt(
      "sess-verify",
      new Date(Date.now() - 252_000).toISOString().replace(/\.\d+Z$/, "Z"),
    );

    const timed = await svc.reviews.create(
      "me/proj",
      pr.number,
      { event: "COMMENT", body: "read the whole diff" },
      "sess-verify",
    );
    expect(timed.duration_seconds).toBeGreaterThanOrEqual(252);
    expect(timed.duration_seconds).toBeLessThan(300);

    const untimed = await svc.reviews.create(
      "me/proj",
      pr.number,
      { event: "COMMENT", body: "no session at all" },
      "sess-unregistered",
    );
    expect(untimed.duration_seconds).toBeNull();
  });

  // The CLI's human session (agent "me") is persistent — one row per LOOPHUB_HOME, reused by every
  // human write — so its start is when the home was created, not when a review began. A human
  // review must therefore record no session at all, or it would report the home's age as its
  // duration. This is the default path for `lh pr review` without an explicit session.
  test("records no session for a human review, so it reports no duration", async () => {
    const pr = await svc.pulls.create(
      "me/proj",
      { title: "human review duration", head: "main", base: "main" },
      "sess-1",
    );
    // agent "me" is what marks a session as the human one (service/shared.ts commentActor).
    svc.sessions.register({
      id: "sess-human",
      agent: "me",
      session: "sess-human",
    });
    S.setAgentSessionCreatedAt(
      "sess-human",
      new Date(Date.now() - 8_309_851_000)
        .toISOString()
        .replace(/\.\d+Z$/, "Z"),
    );

    const human = await svc.reviews.create(
      "me/proj",
      pr.number,
      { event: "FEEDBACK", body: "posted by hand" },
      "sess-human",
    );
    expect(human.author_type).toBe("human");
    expect(human.duration_seconds).toBeNull();

    const repo = S.getRepo("me", "proj")!;
    const row = S.getIssue(repo.id, pr.number)!;
    const stored = S.listReviews(row.id).find((r) => r.id === human.id)!;
    expect(stored.session_id).toBeNull();
  });
});
