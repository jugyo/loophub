import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-dev-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

// Read a PR's stored dev-session attribution (pulls.session_id) by PR number.
function prSession(prNumber: number): string | null {
  const repoId = (S.getRepo("me", "proj") as { id: number }).id;
  const issueId = (S.getIssue(repoId, prNumber) as { id: number }).id;
  return S.getPull(issueId).session_id ?? null;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-dev-repo-"));
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

describe("dev.openPr", () => {
  test("opens a draft PR linked to the issue, then is idempotent", async () => {
    const issue = svc.issues.create("me/proj", { title: "feature A" });
    expect(issue.number).toBe(1);

    const first = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, head: "loophub/issue-1", base: "main" },
      "sess-1",
    );
    expect(first.created).toBe(true);

    const pull = (await svc.pulls.get("me/proj", first.number)) as any;
    expect(pull.head.ref).toBe("loophub/issue-1");
    expect(pull.base.ref).toBe("main");
    expect(pull.linked_issue?.number).toBe(issue.number);
    expect(pull.body).toContain(`Closes #${issue.number}`);

    // Second call finds the existing open PR and does not create another.
    const second = await svc.dev.openPr(
      "me/proj",
      { issue: issue.number, head: "loophub/issue-1", base: "main" },
      "sess-1",
    );
    expect(second.created).toBe(false);
    expect(second.number).toBe(first.number);
  });

  test("attributes the session to the PR row and re-attaches on re-run", async () => {
    svc.sessions.register({ id: "sess-a", agent: "lh-dev", session: "sess-a" });
    svc.sessions.register({ id: "sess-b", agent: "lh-dev", session: "sess-b" });
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

  test("a closed PR frees the open-PR slot; reopening it while another open PR exists is refused", async () => {
    const issue = svc.issues.create("me/proj", { title: "feature C" });
    const pr1 = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );
    // Close PR1 → slot freed → a second openPr creates a fresh PR.
    svc.pulls.update("me/proj", pr1.number, { state: "closed" }, "sess-1");
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
    expect(pr2.number).not.toBe(pr1.number);
    // Reopening PR1 would give the issue two open PRs → clean 422, not a raw constraint error.
    expect(() =>
      svc.pulls.update("me/proj", pr1.number, { state: "open" }, "sess-1"),
    ).toThrow(/already has an open pull request/);
    // The refused reopen left PR1 closed (the state change rolled back).
    const pr1View = (await svc.pulls.get("me/proj", pr1.number)) as any;
    expect(pr1View.state).toBe("closed");
  });
});

describe("dev.note", () => {
  test("emits dev.note resolving the PR from the issue", async () => {
    const issue = svc.issues.create("me/proj", { title: "feature B" });
    const pr = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const note = svc.dev.note(
      "me/proj",
      {
        kind: "decision",
        summary: "use SQLite",
        body: "node:sqlite",
        issue: issue.number,
      },
      "sess-1",
    );
    expect(note).toEqual({
      issue_number: issue.number,
      pr_number: pr.number,
      kind: "decision",
      summary: "use SQLite",
      body: "node:sqlite",
    });

    // Persisted to the shared events table with the session's actor.
    const events = svc.events.list({ repo: "me/proj", limit: 100 });
    const devNote = events.find(
      (e) =>
        e.type === "dev.note" && (e.payload as any).pr_number === pr.number,
    );
    expect(devNote).toBeDefined();
    expect(devNote?.actor).toBe("lh-dev");
    expect((devNote?.payload as any).summary).toBe("use SQLite");
  });

  test("resolves the issue from the PR and omits an empty body", async () => {
    const issue = svc.issues.create("me/proj", { title: "feature C" });
    const pr = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const note = svc.dev.note(
      "me/proj",
      { kind: "blocker", summary: "needs review", pr: pr.number },
      "sess-1",
    );
    expect(note.issue_number).toBe(issue.number);
    expect(note.pr_number).toBe(pr.number);
    expect("body" in note).toBe(false);
  });

  test("rejects a mismatched --issue / --pr pair", async () => {
    const issueX = svc.issues.create("me/proj", { title: "feature E" });
    const pr = await svc.dev.openPr(
      "me/proj",
      {
        issue: issueX.number,
        head: `loophub/issue-${issueX.number}`,
        base: "main",
      },
      "sess-1",
    );
    const otherIssue = svc.issues.create("me/proj", { title: "unrelated" });
    expect(() =>
      svc.dev.note(
        "me/proj",
        {
          kind: "action",
          summary: "x",
          issue: otherIssue.number,
          pr: pr.number,
        },
        "sess-1",
      ),
    ).toThrowError(/not linked to PR/);
  });

  test("rejects an invalid kind", () => {
    const issue = svc.issues.create("me/proj", { title: "feature D" });
    expect(() =>
      svc.dev.note(
        "me/proj",
        { kind: "nope", summary: "x", issue: issue.number },
        "sess-1",
      ),
    ).toThrowError(/invalid kind/);
  });

  test("requires a summary", () => {
    expect(() =>
      svc.dev.note(
        "me/proj",
        { kind: "action", summary: "  ", issue: 1 },
        "sess-1",
      ),
    ).toThrowError(/summary is required/);
  });

  test("requires one of issue or pr", () => {
    expect(() =>
      svc.dev.note("me/proj", { kind: "action", summary: "x" }, "sess-1"),
    ).toThrowError(/one of issue or pr/);
  });
});
