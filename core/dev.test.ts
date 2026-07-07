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

  repoPath = mkdtempSync(join(tmpdir(), "lh-build-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);

  await svc.repos.create({ path: repoPath, name: "me/proj" });
  svc.sessions.register({ id: "sess-1", agent: "lh-build", session: "sess-1" });
});

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
  // pull_request.updated on re-attribution so the PR detail's related-sessions list (SSE-driven)
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
