import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "#loophub-test";

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
  svc.sessions.register({ id: "sess-1", agent: "lh-build", session: "sess-1" });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

describe("dashboard.overview", () => {
  test("Unicode を含む repository 名を picker と同じ順序で返す", async () => {
    const registered = [
      S.createRepo("a/z", "/tmp/dashboard-sort-a"),
      S.createRepo("Ä/alpha", "/tmp/dashboard-sort-umlaut-a"),
      S.createRepo("e/z", "/tmp/dashboard-sort-e"),
      S.createRepo("É/alpha", "/tmp/dashboard-sort-acute-e"),
      S.createRepo("z/favorite", "/tmp/dashboard-sort-favorite"),
    ];
    S.setRepoFavorite(registered[4].id, true);

    const overview = await svc.dashboard.overview();
    const names = new Set(registered.map((repo) => repo.full_name));
    const order = overview.repositories
      .map((repository) => repository.repo.full_name)
      .filter((name) => names.has(name));

    expect(order).toEqual(["z/favorite", "Ä/alpha", "a/z", "É/alpha", "e/z"]);
  });

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
    const withClosedPr = svc.issues.create("me/proj", {
      title: "has a closed PR",
    });
    const closedPr = await svc.dev.openPr(
      "me/proj",
      {
        issue: withClosedPr.number,
        head: `loophub/issue-${withClosedPr.number}`,
        base: "main",
      },
      "sess-1",
    );
    const noPr = svc.issues.create("me/proj", { title: "no PR" });
    const repo = S.getRepo("me", "proj")!;
    S.updateIssue(S.getIssue(repo.id, closedPr.number)!.id, {
      state: "closed",
    });
    const noPrRow = S.getIssue(repo.id, noPr.number)!;
    S.upsertIssueHerdrPane({
      launchId: "dashboard-launch",
      repoId: repo.id,
      issueId: noPrRow.id,
      paneId: "w3:p1",
      sessionName: "me-proj-dashboard",
    });

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
    expect(enriched.has_open_pull_request).toBe(true);

    const closed = item(withClosedPr.number)!;
    expect(closed.linked_pull_requests).toHaveLength(1);
    expect(closed.has_open_pull_request).toBe(false);

    // An issue with no linked PR stays a one-row item: empty array, null singular.
    const plain = item(noPr.number)!;
    expect(plain.linked_pull_requests).toEqual([]);
    expect(plain.linked_pull_request).toBeNull();
    expect(plain.has_open_pull_request).toBe(false);
    expect(plain.herdr_pane).toMatchObject({
      pane_id: "w3:p1",
      session_name: "me-proj-dashboard",
    });
  });

  test("open issue のみを表示し、全状態の件数と上限を報告する", async () => {
    for (let i = 0; i < 20; i++) {
      svc.issues.create("me/proj", { title: `issue ${i}` });
    }
    const closed = svc.issues.create("me/proj", { title: "closed issue" });
    const closedRow = S.getIssue(S.getRepo("me", "proj")!.id, closed.number)!;
    S.updateIssue(closedRow.id, { state: "closed" });

    const overview = await svc.dashboard.overview();
    const repository = overview.repositories.find(
      (item) => item.repo.full_name === "me/proj",
    )!;

    expect(repository.total_issues).toBe(24);
    expect(repository.open_issues).toBe(23);
    expect(repository.closed_issues).toBe(1);
    expect(repository.issues).toHaveLength(20);
    expect(repository.issue_limit).toBe(20);
    expect(repository.has_more).toBe(true);
    expect(repository.issues.every((issue) => issue.state === "open")).toBe(
      true,
    );
    expect(overview.total_issues).toBe(24);
    expect(overview.total_open_issues).toBe(23);
    expect(overview.total_closed_issues).toBe(1);
  });

  test("open issue がない repository では空状態のデータを返す", async () => {
    const repo = S.getRepo("me", "proj")!;
    for (const row of S.listIssues(repo.id, "issue", "all", "created", {
      rootsOnly: true,
    })) {
      if (row.state === "open") S.updateIssue(row.id, { state: "closed" });
    }

    const overview = await svc.dashboard.overview();
    const repository = overview.repositories.find(
      (item) => item.repo.full_name === "me/proj",
    )!;

    expect(repository.issues).toEqual([]);
    expect(repository.open_issues).toBe(0);
    expect(repository.closed_issues).toBe(repository.total_issues);
    expect(repository.has_more).toBe(false);
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
      (await svc.issues.get("me/proj", issue.number)).linked_pull_requests![0]
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
      (await svc.issues.get("me/proj", issue.number)).linked_pull_requests![0]
        .github_pull,
    ).toMatchObject({ number: 99 });
  });

  test("issue detail enriches every linked PR", async () => {
    const issue = svc.issues.create("me/proj", { title: "many linked PRs" });
    const repo = S.getRepo("me", "proj")!;
    const issueRow = S.getIssue(repo.id, issue.number)!;
    for (let i = 0; i < S.MAX_ISSUE_DETAIL_PULLS + 2; i++) {
      const pr = S.createIssue(
        repo.id,
        "pull",
        `attempt ${i}`,
        `Closes #${issue.number}`,
        "bot",
      );
      S.createPull(pr.id, `attempt-${i}`, "main", `sha-${i}`, issueRow.id);
    }

    const detail = await svc.issues.get("me/proj", issue.number);

    expect(detail.linked_pull_requests).toHaveLength(S.MAX_ISSUE_DETAIL_PULLS);
    expect(detail.linked_pull_requests_truncated).toBe(true);
    expect(detail.linked_pull_request?.number).toBe(
      detail.linked_pull_requests![0].number,
    );
    expect(detail.linked_pull_requests![0]).toHaveProperty("mergeable_state");
    expect(detail.linked_pull_requests![S.MAX_LINKED_PULLS]).toHaveProperty(
      "mergeable_state",
    );
    expect(detail.linked_pull_requests![S.MAX_LINKED_PULLS]).toHaveProperty(
      "base_commits_behind",
    );
  });

  test("issue detail reports commits added to the base after a PR forked", async () => {
    const issue = svc.issues.create("me/proj", { title: "old attempt base" });
    await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    writeFileSync(join(repoPath, "base-advanced.txt"), "advanced\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "advance base"]);

    const detail = await svc.issues.get("me/proj", issue.number);
    expect(detail.linked_pull_requests![0].base_commits_behind).toBe(1);
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

  test("repository sections include sub issues below their visible parent", async () => {
    const parent = svc.issues.create("me/proj", { title: "dashboard parent" });
    const child = svc.issues.create("me/proj", { title: "dashboard child" });
    svc.issues.attachSubIssue("me/proj", parent.number, child.number);

    const overview = await svc.dashboard.overview();
    const repository = overview.repositories.find(
      (item) => item.repo.full_name === "me/proj",
    )!;
    const parentIssue = repository.issues.find(
      (issue) => issue.number === parent.number,
    )!;

    expect(parentIssue.sub_issues).toMatchObject([
      {
        number: child.number,
        title: "dashboard child",
        depth: 2,
        sub_issue_ordinal: 1,
      },
    ]);
    expect(
      repository.issues.some((issue) => issue.number === child.number),
    ).toBe(false);
  });

  test("linked PR totals its comments and diff comments (#2152)", async () => {
    const issue = svc.issues.create("me/proj", { title: "gets comment count" });
    const pr = await svc.dev.openPr(
      "me/proj",
      {
        issue: issue.number,
        head: `loophub/issue-${issue.number}`,
        base: "main",
      },
      "sess-1",
    );

    const totalComments = async () => {
      const overview: any = await svc.dashboard.overview();
      return overview.issues.find((i: any) => i.issue.number === issue.number)
        ?.issue.linked_pull_requests[0].total_comments;
    };

    // A PR nobody has said anything on reports zero, not an absent field.
    expect(await totalComments()).toBe(0);

    svc.comments.createHumanForPull("me/proj", pr.number, "one comment");
    const repo = S.getRepo("me", "proj")!;
    const thread = S.createDiffFeedbackThread({
      issueId: S.getIssue(repo.id, pr.number)!.id,
      prNumber: pr.number,
      baseSha: "base",
      headSha: "head",
      path: "a.txt",
      originalPath: null,
      side: "RIGHT",
      startLine: 1,
      endLine: 1,
      actor: "me",
      authorType: "human",
    });
    S.createDiffFeedbackMessage(thread.id, "me", "on this line");
    S.createDiffFeedbackMessage(thread.id, "agent", "fixed");

    // One conversation comment plus both messages of the diff thread, as a single number.
    expect(await totalComments()).toBe(3);
  });

  test("filters grouped issues by every requested label and lists active labels", async () => {
    const both = svc.issues.create("me/proj", {
      title: "has both labels",
      labels: ["bug", "ui"],
    });
    svc.issues.create("me/proj", { title: "has only bug", labels: ["bug"] });
    const closed = svc.issues.create("me/proj", {
      title: "closed with both labels",
      labels: ["bug", "ui"],
    });
    S.updateIssue(S.getIssue(S.getRepo("me", "proj")!.id, closed.number)!.id, {
      state: "closed",
    });

    const overview = await svc.dashboard.overview([" bug ", "ui"]);
    const repository = overview.repositories.find(
      (item) => item.repo.full_name === "me/proj",
    )!;

    expect(overview.labels).toEqual(
      expect.arrayContaining([
        { name: "bug", color: null },
        { name: "ui", color: null },
      ]),
    );
    expect(repository.total_issues).toBe(2);
    expect(repository.open_issues).toBe(1);
    expect(repository.closed_issues).toBe(1);
    expect(repository.issues.map((issue) => issue.number)).toEqual([
      both.number,
    ]);
  });
});
