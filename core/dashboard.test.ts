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
let S: typeof import("./store.ts");
let repoPath: string;

function git(args: string[]) {
  spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");

  repoPath = mkdtempSync(join(tmpdir(), "lh-dashboard-repo-"));
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "x\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "init"]);
  // A GitHub origin so recordGithubPull accepts the export (#629 github_pull badge).
  git(["remote", "add", "origin", "https://github.com/me/proj.git"]);

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
    const enriched = item(withPr.number)!;
    expect(Array.isArray(enriched.linked_pull_requests)).toBe(true);
    expect(enriched.linked_pull_requests!).toHaveLength(1);
    expect(enriched.linked_pull_requests![0]).toHaveProperty("mergeable_state");
    expect(enriched.linked_pull_requests![0]).toHaveProperty("changed_files");
    expect(enriched.linked_pull_request?.number).toBe(
      enriched.linked_pull_requests![0].number,
    );

    // An issue with no linked PR stays a one-row item: empty array, null singular.
    const plain = item(noPr.number)!;
    expect(plain.linked_pull_requests).toEqual([]);
    expect(plain.linked_pull_request).toBeNull();
  });

  test("linked PR carries github_pull once exported, null otherwise (#629)", async () => {
    const issue = svc.issues.create("me/proj", { title: "gets a GitHub PR" });
    const pr = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const linkedPull = (o: any) =>
      o.issues.find((i: any) => i.issue.number === issue.number)?.issue
        .linked_pull_requests[0];

    // Before export: the field is present on the wire but null (no github_pulls row).
    const before = linkedPull(await svc.dashboard.overview());
    expect(before).toHaveProperty("github_pull", null);
    // issues.get (pullSummary path) mirrors the list.
    expect(
      svc.issues.get("me/proj", issue.number).linked_pull_requests![0]
        .github_pull,
    ).toBeNull();

    svc.pulls.recordGithubPull("me/proj", pr.number, {
      github_number: 99,
      url: "https://github.com/me/proj/pull/99",
    });

    // After export: both the list (linkedPullDetail) and detail (pullSummary) expose it.
    const after = linkedPull(await svc.dashboard.overview());
    expect(after.github_pull).toMatchObject({
      number: 99,
      url: "https://github.com/me/proj/pull/99",
    });
    expect(
      svc.issues.get("me/proj", issue.number).linked_pull_requests![0]
        .github_pull,
    ).toMatchObject({ number: 99 });
  });

  test("linked PR carries agent runtime/model and cost once its session has usage (#783, #842)", async () => {
    const issue = svc.issues.create("me/proj", { title: "gets agent cost" });
    await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const linkedPull = (o: any) =>
      o.issues.find((i: any) => i.issue.number === issue.number)?.issue
        .linked_pull_requests[0];

    // Before any usage is recorded: the fields are simply absent, not zero.
    const before = linkedPull(await svc.dashboard.overview());
    expect(before.total_tokens).toBeUndefined();
    expect(before.cost_usd).toBeUndefined();
    expect(before.agent_runtime).toBe("claude-code");
    expect(before.agent_model).toBeUndefined();

    // "sess-1" is already linked to the PR's issue row as its dev session (openPr ->
    // setPullSession above), so recording usage against it is enough for the aggregate query to
    // pick it up.
    S.upsertSessionUsage("sess-1", {
      model: "claude-sonnet-5",
      input_tokens: 100,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 50,
      cost_usd: 1.23,
    });

    const after = linkedPull(await svc.dashboard.overview());
    expect(after.total_tokens).toBe(200);
    expect(after.cost_usd).toBe(1.23);
    expect(after.agent_runtime).toBe("claude-code");
    expect(after.agent_model).toBe("claude-sonnet-5");
  });

  test("linked PR carries work_duration_total using the #456 total (#882)", async () => {
    const issue = svc.issues.create("me/proj", { title: "gets work duration" });
    await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const linkedPull = (o: any) =>
      o.issues.find((i: any) => i.issue.number === issue.number)?.issue
        .linked_pull_requests[0];

    // A PR with a dev session but no ready_for_review yet reports its still-growing total under the
    // `in_progress` basis — the same `pullWorkDuration().total` the detail sidebar shows, not a new
    // calculation. Only `total` (seconds + basis) is on the sub-row; no phase breakdown.
    const linked = linkedPull(await svc.dashboard.overview());
    expect(linked.work_duration_total).toMatchObject({ basis: "in_progress" });
    expect(linked.work_duration_total.seconds).toBeGreaterThanOrEqual(0);
    expect(linked).not.toHaveProperty("implementation");
    expect(linked).not.toHaveProperty("review");
  });
});
