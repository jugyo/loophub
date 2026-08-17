import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "..", "index.ts");
const home = mkdtempSync(join(tmpdir(), "lh-issue-cli-home-"));
const repoPath = mkdtempSync(join(tmpdir(), "lh-issue-cli-repo-"));

function git(args: string[]) {
  return spawnSync("git", ["-C", repoPath, ...args], { encoding: "utf8" });
}

function lh(args: string[], input?: string) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      input,
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
      },
    },
  );
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.status,
  };
}

function createIssue(title: string): number {
  const created = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    title,
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  return JSON.parse(created.stdout).number;
}

beforeAll(() => {
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.email", "t@t.local"]);
  git(["config", "user.name", "tester"]);
  writeFileSync(join(repoPath, "a.txt"), "initial\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "initial"]);

  const registered = lh(["repo", "add", repoPath, "--name", "me/proj"]);
  expect(registered.exitCode, registered.stderr).toBe(0);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repoPath, { recursive: true, force: true });
});

test("lh issue create returns the created issue with --json", () => {
  const number = createIssue("json create");
  expect(number).toBeGreaterThan(0);

  const plain = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "plain create",
  ]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(plain.stdout.trim()).toMatch(/^created #\d+$/);
});

test("lh issue create --parent creates a sub-issue", () => {
  const parent = createIssue("CLI parent");
  const child = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "CLI child",
    "--parent",
    String(parent),
    "--json",
  ]);
  expect(child.exitCode, child.stderr).toBe(0);
  const childNumber = JSON.parse(child.stdout).number;

  const listed = lh([
    "issue",
    "list",
    "--repo",
    "me/proj",
    "--state",
    "all",
    "--json",
  ]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(
    JSON.parse(listed.stdout).map((issue: any) => issue.number),
  ).not.toContain(childNumber);
});

test("lh issue sub commands, hierarchy text, and open summary output work", () => {
  const parent = createIssue("sub command parent");
  const childA = createIssue("sub command child A");
  const childB = createIssue("sub command child B");

  for (const child of [childA, childB]) {
    const added = lh([
      "issue",
      "sub",
      "add",
      String(parent),
      String(child),
      "--repo",
      "me/proj",
      "--json",
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
  }

  const listed = lh([
    "issue",
    "sub",
    "list",
    String(parent),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(JSON.parse(listed.stdout).map((issue: any) => issue.number)).toEqual([
    childA,
    childB,
  ]);

  const reordered = lh([
    "issue",
    "sub",
    "reorder",
    String(parent),
    "--order",
    `${childB},${childA}`,
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(reordered.exitCode, reordered.stderr).toBe(0);
  expect(
    JSON.parse(reordered.stdout).map((issue: any) => issue.number),
  ).toEqual([childB, childA]);

  const closed = lh(["issue", "close", String(childA), "--repo", "me/proj"]);
  expect(closed.exitCode, closed.stderr).toBe(0);
  const childC = createIssue("sub command child C");
  const added = lh([
    "issue",
    "sub",
    "add",
    String(parent),
    String(childC),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(added.exitCode, added.stderr).toBe(0);
  const listText = lh(["issue", "list", "--state", "all", "--repo", "me/proj"]);
  expect(listText.exitCode, listText.stderr).toBe(0);
  expect(listText.stdout).toContain(`sub 2/3`);
  expect(listText.stdout).toContain(
    "use 'lh issue sub list <n>' to see sub issues",
  );

  const viewText = lh(["issue", "view", String(childA), "--repo", "me/proj"]);
  expect(viewText.exitCode, viewText.stderr).toBe(0);
  expect(viewText.stdout).toContain(`Parent: #${parent}`);

  const parentView = lh(["issue", "view", String(parent), "--repo", "me/proj"]);
  expect(parentView.exitCode, parentView.stderr).toBe(0);
  expect(parentView.stdout).toContain("Sub issues");
  expect(parentView.stdout).toContain(`#${childB} [open] sub command child B`);

  const removed = lh([
    "issue",
    "sub",
    "remove",
    String(childA),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(removed.exitCode, removed.stderr).toBe(0);
  expect(JSON.parse(removed.stdout).number).toBe(childA);
});

test("lh issue view exposes display ids for acceptance criteria", () => {
  const created = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "display ids",
    "--ac",
    "first",
    "--ac",
    "second",
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  const issueNumber = JSON.parse(created.stdout).number;

  const viewed = lh([
    "issue",
    "view",
    String(issueNumber),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(viewed.exitCode, viewed.stderr).toBe(0);
  expect(JSON.parse(viewed.stdout).acceptance_criteria).toEqual([
    { id: `${issueNumber}-1`, number: 1, ordinal: 1, text: "first" },
    { id: `${issueNumber}-2`, number: 2, ordinal: 2, text: "second" },
  ]);
});

test("lh issue comment returns the created comment", () => {
  const number = createIssue("comment target");

  const plain = lh([
    "issue",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "hello",
  ]);
  expect(plain.exitCode, plain.stderr).toBe(0);
  expect(plain.stdout).toContain(`commented on #${number} (comment `);

  const json = lh([
    "issue",
    "comment",
    String(number),
    "--repo",
    "me/proj",
    "--body",
    "second",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  const comment = JSON.parse(json.stdout);
  expect(comment).toMatchObject({ body: "second" });
  expect(comment.id).toBeGreaterThan(0);
});

// #2494: archiving keeps the comment but takes it out of the list a reader gets by default.
test("lh issue comment archive|unarchive hides and restores a comment in the list", () => {
  const number = createIssue("comment archive target");
  function comment(body: string): number {
    const created = lh([
      "issue",
      "comment",
      String(number),
      "--repo",
      "me/proj",
      "--body",
      body,
      "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    return JSON.parse(created.stdout).id;
  }
  function listedIds(args: string[] = []): number[] {
    const viewed = lh([
      "issue",
      "view",
      String(number),
      "--repo",
      "me/proj",
      "--json",
      ...args,
    ]);
    expect(viewed.exitCode, viewed.stderr).toBe(0);
    return JSON.parse(viewed.stdout).comment_list.map((c: any) => c.id);
  }

  const kept = comment("keep this");
  const settled = comment("settled");

  const archived = lh([
    "issue",
    "comment",
    "archive",
    String(settled),
    "--issue",
    String(number),
    "--repo",
    "me/proj",
  ]);
  expect(archived.exitCode, archived.stderr).toBe(0);
  expect(archived.stdout).toContain(`archived issue comment ${settled}`);

  expect(listedIds()).toEqual([kept]);
  const withArchived = lh([
    "issue",
    "view",
    String(number),
    "--repo",
    "me/proj",
    "--json",
    "--include-archived",
  ]);
  expect(withArchived.exitCode, withArchived.stderr).toBe(0);
  const all = JSON.parse(withArchived.stdout).comment_list;
  expect(all.map((c: any) => c.id)).toEqual([kept, settled]);
  expect(all.find((c: any) => c.id === settled).archived_at).not.toBeNull();

  const unarchived = lh([
    "issue",
    "comment",
    "unarchive",
    String(settled),
    "--issue",
    String(number),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(unarchived.exitCode, unarchived.stderr).toBe(0);
  expect(JSON.parse(unarchived.stdout).archived_at).toBeNull();
  expect(listedIds()).toEqual([kept, settled]);
});

test("lh issue comment archive requires the target issue", () => {
  const result = lh(["issue", "comment", "archive", "1", "--repo", "me/proj"]);
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("--issue is required");
});

test("free-text body input preserves Markdown from stdin and files", () => {
  const body = "line one `id`\nline two\n";
  const fromStdin = lh(
    [
      "issue",
      "create",
      "--repo",
      "me/proj",
      "--title",
      "stdin body",
      "--body",
      "-",
      "--json",
    ],
    body,
  );
  expect(fromStdin.exitCode, fromStdin.stderr).toBe(0);
  const created = JSON.parse(fromStdin.stdout);
  expect(created.body).toBe(body);

  const file = join(home, "body.md");
  writeFileSync(file, body);
  const updated = lh([
    "issue",
    "update",
    String(created.number),
    "--repo",
    "me/proj",
    "--body",
    `@${file}`,
    "--json",
  ]);
  expect(updated.exitCode, updated.stderr).toBe(0);
  expect(JSON.parse(updated.stdout).body).toBe(body);
});

test("free-text body keeps legacy inline text beginning with @", () => {
  const body = "@alice の確認";
  const created = lh([
    "issue",
    "create",
    "--repo",
    "me/proj",
    "--title",
    "at-prefixed body",
    "--body",
    body,
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  expect(JSON.parse(created.stdout).body).toBe(body);
});

test("lh issue close reports the state transition and the already-closed no-op", () => {
  const number = createIssue("close target");

  const closed = lh(["issue", "close", String(number), "--repo", "me/proj"]);
  expect(closed.exitCode, closed.stderr).toBe(0);
  expect(closed.stdout).toContain(`closed #${number} (open -> closed)`);

  const again = lh(["issue", "close", String(number), "--repo", "me/proj"]);
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain(`#${number} was already closed (no change)`);

  const json = lh([
    "issue",
    "close",
    String(number),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ number, state: "closed" });
});

test("lh issue label reports the resulting labels and the no-op add", () => {
  const number = createIssue("label target");

  const labeled = lh([
    "issue",
    "label",
    String(number),
    "--repo",
    "me/proj",
    "--add",
    "bug,ui",
  ]);
  expect(labeled.exitCode, labeled.stderr).toBe(0);
  expect(labeled.stdout).toContain(
    `labeled #${number} (added: bug, ui) — labels: bug, ui`,
  );

  const again = lh([
    "issue",
    "label",
    String(number),
    "--repo",
    "me/proj",
    "--add",
    "bug",
  ]);
  expect(again.exitCode, again.stderr).toBe(0);
  expect(again.stdout).toContain(`#${number} already had bug (no change)`);

  const json = lh([
    "issue",
    "label",
    String(number),
    "--repo",
    "me/proj",
    "--add",
    "docs",
    "--json",
  ]);
  expect(json.exitCode, json.stderr).toBe(0);
  expect(JSON.parse(json.stdout).map((l: { name: string }) => l.name)).toEqual(
    expect.arrayContaining(["bug", "ui", "docs"]),
  );
});

test("lh issue ac shows and accepts issue-local references", () => {
  const number = createIssue("AC refs");
  const added = lh([
    "issue",
    "ac",
    "add",
    String(number),
    "--repo",
    "me/proj",
    "--text",
    "first",
  ]);
  expect(added.exitCode, added.stderr).toBe(0);
  expect(added.stdout).toContain(`${number}-1`);

  const disabled = lh([
    "issue",
    "ac",
    "disable",
    `${number}-1`,
    "--repo",
    "me/proj",
  ]);
  expect(disabled.exitCode, disabled.stderr).toBe(0);
  expect(disabled.stdout).toContain(`${number}-1`);

  const enabled = lh([
    "issue",
    "ac",
    "enable",
    `${number}-1`,
    "--repo",
    "me/proj",
  ]);
  expect(enabled.exitCode, enabled.stderr).toBe(0);
  expect(enabled.stdout).toContain(`${number}-1`);

  const disabledByShorthand = lh([
    "issue",
    "ac",
    "disable",
    String(number),
    "ac-1",
    "--repo",
    "me/proj",
  ]);
  expect(disabledByShorthand.exitCode, disabledByShorthand.stderr).toBe(0);

  const listed = lh([
    "issue",
    "ac",
    "list",
    String(number),
    "--repo",
    "me/proj",
  ]);
  expect(listed.exitCode, listed.stderr).toBe(0);
  expect(listed.stdout).toContain(`${number}-1\t1\tdisabled\tfirst`);
  expect(listed.stdout).not.toMatch(/\t#\d+\t/);

  const listedJson = lh([
    "issue",
    "ac",
    "list",
    String(number),
    "--repo",
    "me/proj",
    "--json",
  ]);
  expect(listedJson.exitCode, listedJson.stderr).toBe(0);
  expect(JSON.parse(listedJson.stdout)).toEqual([
    expect.objectContaining({ id: `${number}-1`, enabled: false }),
  ]);

  const internalId = lh([
    "issue",
    "ac",
    "disable",
    "999999",
    "--repo",
    "me/proj",
  ]);
  expect(internalId.exitCode).not.toBe(0);
  expect(internalId.stderr).toContain(
    "acceptance criterion reference must be <issue-number>-<ac-number>",
  );
});
