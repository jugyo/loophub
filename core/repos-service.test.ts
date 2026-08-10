import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { git, worktreeAdd } from "./git.ts";

// Isolate the DB before service.ts -> db.ts runs its import-time setup (see AGENTS.md).
const HOME = mkdtempSync(join(tmpdir(), "lh-repos-svc-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let svc: typeof import("./service.ts");
let S: typeof import("./store.ts");

// repos.create requires a real git repo on disk; each test registers its own bare
// checkout so full_name / local_path stay unique across the file.
function initGitRepo(): string {
  const path = mkdtempSync(join(HOME, "repo-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: path });
  return path;
}

beforeAll(async () => {
  svc = await import("./service.ts");
  S = await import("./store.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("setFavorite toggles favorite, emits favorited/unfavorited events (#457)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/fav-svc" });

  const favorited = svc.repos.setFavorite("me/fav-svc", true);
  expect(favorited.favorite).toBe(true);
  expect(favorited.favorited_at).not.toBeNull();

  const unfavorited = svc.repos.setFavorite("me/fav-svc", false);
  expect(unfavorited.favorite).toBe(false);
  expect(unfavorited.favorited_at).toBeNull();
});

test("create emits repo.created so other web sessions refresh repo lists", async () => {
  const created = await svc.repos.create(
    { path: initGitRepo(), name: "me/create-event" },
    "web-session-1",
  );

  const ev = S.listEvents(0, created.id, 100).find(
    (e: any) => e.type === "repo.created",
  )!;
  expect(ev).toBeTruthy();
  expect(ev.actor).toBe("unknown");
  expect(JSON.parse(ev.payload)).toEqual({
    full_name: "me/create-event",
  });
});

test("remove deletes repository workflows while preserving global workflows", async () => {
  const repo = await svc.repos.create({
    path: initGitRepo(),
    name: "me/remove-scoped-workflow",
  });
  const global = svc.workflows.create({ name: "remove-scoped-workflow" });
  const scoped = svc.workflows.create({
    name: "remove-scoped-workflow",
    repo: repo.full_name,
  });

  expect(() => svc.repos.remove(repo.full_name)).not.toThrow();
  expect(S.getRepoById(repo.id)).toBeNull();
  expect(S.getWorkflowById(scoped.id)).toBeNull();
  expect(S.getWorkflowById(global.id)?.id).toBe(global.id);
});

test("setFavorite rejects a non-boolean favorite value (#457)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/fav-svc-bad" });
  expect(() =>
    svc.repos.setFavorite("me/fav-svc-bad", "yes" as unknown as boolean),
  ).toThrow(/favorite must be a boolean/);
});

test("list sorts favorites first (#457)", async () => {
  const a = await svc.repos.create({
    path: initGitRepo(),
    name: "me/fav-svc-list-a",
  });
  const b = await svc.repos.create({
    path: initGitRepo(),
    name: "me/fav-svc-list-b",
  });
  svc.repos.setFavorite(b.full_name, true);

  const ids = svc.repos
    .list("all")
    .map((r: any) => r.id)
    .filter((id: number) => id === a.id || id === b.id);
  expect(ids).toEqual([b.id, a.id]);
});

test("rename changes owner/name, emits repo.renamed, and the old name 404s (#485)", async () => {
  const created = await svc.repos.create({
    path: initGitRepo(),
    name: "me/rn-a",
  });

  const renamed = await svc.repos.rename("me/rn-a", "acme/rn-b");
  expect(renamed.id).toBe(created.id);
  expect(renamed.full_name).toBe("acme/rn-b");

  // Name-based resolution (the same lookup `--repo owner/name` and /r/:owner/:repo use)
  // works under the new name and no longer under the old one.
  expect(svc.repos.get("acme/rn-b").id).toBe(created.id);
  expect(() => svc.repos.get("me/rn-a")).toThrow(/Not Found/);

  const ev = S.listEvents(0, created.id, 100).find(
    (e: any) => e.type === "repo.renamed",
  )!;
  expect(ev).toBeTruthy();
  expect(JSON.parse(ev.payload)).toEqual({
    full_name: "acme/rn-b",
    from: "me/rn-a",
  });
});

test("rename refuses a full_name that is already registered (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-c" });
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-d" });
  await expect(svc.repos.rename("me/rn-c", "me/rn-d")).rejects.toThrow(
    /already registered/,
  );
});

test("rename rejects malformed names (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-e" });
  await expect(svc.repos.rename("me/rn-e", "a/b/c")).rejects.toThrow(
    /invalid repo name/,
  );
  await expect(svc.repos.rename("me/rn-e", "../evil")).rejects.toThrow(
    /invalid repo name/,
  );
  await expect(svc.repos.rename("me/rn-e", "   ")).rejects.toThrow(/non-empty/);
});

test("rename to the same name is a no-op without an event (#485)", async () => {
  const created = await svc.repos.create({
    path: initGitRepo(),
    name: "me/rn-same",
  });
  const same = await svc.repos.rename("me/rn-same", "me/rn-same");
  expect(same.full_name).toBe("me/rn-same");
  const events = S.listEvents(0, created.id, 100).filter(
    (e: any) => e.type === "repo.renamed",
  );
  expect(events).toEqual([]);
});

// Worktree/dev-lock paths derive from full_name, so renaming under a live worktree would
// orphan it; the service refuses until the worktree is gone, then the rename goes through.
test("rename is refused while a worktree exists under the current name (#485)", async () => {
  const path = mkdtempSync(join(HOME, "repo-"));
  await git(path, ["init", "-q", "-b", "main"]);
  await git(path, ["config", "user.email", "t@t.local"]);
  await git(path, ["config", "user.name", "tester"]);
  writeFileSync(join(path, "f.txt"), "base\n");
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-qm", "base"]);
  await svc.repos.create({ path, name: "me/rn-busy" });

  // Same layout `lh build` provisions: <worktreeRoot>/<full_name>/pr-<n>.
  const wt = join(HOME, "worktrees", "me", "rn-busy", "pr-1");
  await worktreeAdd(path, wt, "loophub/pr-1", "main");

  await expect(svc.repos.rename("me/rn-busy", "me/rn-idle")).rejects.toThrow(
    /cannot rename/,
  );

  await git(path, ["worktree", "remove", "--force", wt]);
  const renamed = await svc.repos.rename("me/rn-busy", "me/rn-idle");
  expect(renamed.full_name).toBe("me/rn-idle");
});

// Dev locks (<home>/dev-locks/<full_name>/pr-N.json) are claimed before the worktree is
// provisioned, so the rename guard must see them independently of `git worktree list`.
test("rename is refused while a dev lock exists under the current name (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-locked" });

  const lockDir = join(HOME, "dev-locks", "me", "rn-locked");
  mkdirSync(lockDir, { recursive: true });
  writeFileSync(join(lockDir, "pr-9.json"), "{}");

  await expect(svc.repos.rename("me/rn-locked", "me/rn-free")).rejects.toThrow(
    /dev lock/,
  );

  rmSync(join(lockDir, "pr-9.json"));
  const renamed = await svc.repos.rename("me/rn-locked", "me/rn-free");
  expect(renamed.full_name).toBe("me/rn-free");
});

// Derived worktree/dev-lock dirs live on commonly case-insensitive filesystems, so a
// case-only difference from another repo is a collision; a case-only self-rename is not.
test("rename detects case-insensitive collisions but allows case-only self-rename (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-case" });
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-other" });

  await expect(svc.repos.rename("me/rn-case", "ME/RN-OTHER")).rejects.toThrow(
    /already registered/,
  );

  const renamed = await svc.repos.rename("me/rn-case", "me/RN-Case");
  expect(renamed.full_name).toBe("me/RN-Case");
});

// A git failure (moved/deleted local_path) must refuse the rename rather than read as
// "no worktrees" and silently bypass the orphaning guard.
test("rename is refused when worktrees cannot be verified (local_path gone) (#485)", async () => {
  const path = initGitRepo();
  await svc.repos.create({ path, name: "me/rn-gone" });
  rmSync(path, { recursive: true, force: true });

  await expect(svc.repos.rename("me/rn-gone", "me/rn-still")).rejects.toThrow(
    /cannot verify worktrees/,
  );
});

// Rename edits registration metadata, like setArchived/setFavorite/setMergeMode — an
// archived repo stays renamable.
test("rename works on an archived repo (#485)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/rn-arch" });
  svc.repos.setArchived("me/rn-arch", true);

  const renamed = await svc.repos.rename("me/rn-arch", "me/rn-arch2");
  expect(renamed.full_name).toBe("me/rn-arch2");
  expect(renamed.archived).toBe(true);
});

// #1532: the per-repo Coding agent override end-to-end (persistence + effective resolution). No
// config.json is written in this HOME, so the application defaults are the built-in ones
// (claude-code / opus / medium).
test("agentConfig falls back to the application defaults while the override is off (#1532)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/agent-off" });

  const fresh = svc.repos.agentConfig("me/agent-off");
  expect(fresh.setting).toEqual({
    override: false,
    runtime: null,
    model: null,
    effort: null,
  });
  expect(fresh.effective).toEqual({
    runtime: "claude-code",
    model: "opus",
    effort: "medium",
  });

  // Values stored while the toggle is off persist but stay ineffective.
  const stored = svc.repos.setAgentConfig("me/agent-off", {
    override: false,
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "low",
  });
  expect(stored.setting).toEqual({
    override: false,
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "low",
  });
  expect(stored.effective).toEqual({
    runtime: "claude-code",
    model: "opus",
    effort: "medium",
  });
});

test("agentConfig resolves the repo override while it is on (#1532)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/agent-on" });

  const pinned = svc.repos.setAgentConfig("me/agent-on", {
    override: true,
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "low",
  });
  expect(pinned.effective).toEqual({
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "low",
  });
  // The resolved view survives a re-read (it is persisted, not per-call state).
  expect(svc.repos.agentConfig("me/agent-on").effective).toEqual(
    pinned.effective,
  );

  // Clearing model/effort keeps the pinned runtime and falls back to that runtime's defaults.
  const runtimeOnly = svc.repos.setAgentConfig("me/agent-on", {
    override: true,
    runtime: "codex",
    model: "",
    effort: null,
  });
  expect(runtimeOnly.setting.model).toBeNull();
  expect(runtimeOnly.effective).toEqual({
    runtime: "codex",
    model: "gpt-5.6-sol",
    effort: "medium",
  });
});

test("setAgentConfig rejects an unknown runtime and a non-boolean override (#1532)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/agent-bad" });

  expect(() =>
    svc.repos.setAgentConfig("me/agent-bad", {
      override: true,
      runtime: "gpt",
    }),
  ).toThrow(/runtime must be one of/);
  expect(() =>
    svc.repos.setAgentConfig("me/agent-bad", {
      override: "yes" as unknown as boolean,
    }),
  ).toThrow(/override must be a boolean/);
});

// #2422: per-repo additional "Create PR on GitHub" prompt text.
test("githubPrExportExtraPrompt is null by default and persists set/clear (#2422)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/export-prompt" });

  expect(svc.repos.githubPrExportExtraPrompt("me/export-prompt")).toEqual({
    extra_prompt: null,
  });

  const saved = svc.repos.setGithubPrExportExtraPrompt(
    "me/export-prompt",
    "  Prefer type/short-slug.\n",
  );
  expect(saved).toEqual({ extra_prompt: "Prefer type/short-slug." });
  expect(svc.repos.githubPrExportExtraPrompt("me/export-prompt")).toEqual({
    extra_prompt: "Prefer type/short-slug.",
  });

  // Empty string clears; other repos stay independent.
  await svc.repos.create({ path: initGitRepo(), name: "me/export-prompt-b" });
  svc.repos.setGithubPrExportExtraPrompt(
    "me/export-prompt-b",
    "Other repo only",
  );
  const cleared = svc.repos.setGithubPrExportExtraPrompt(
    "me/export-prompt",
    "",
  );
  expect(cleared).toEqual({ extra_prompt: null });
  expect(svc.repos.githubPrExportExtraPrompt("me/export-prompt-b")).toEqual({
    extra_prompt: "Other repo only",
  });
});

// #71: a checkout cloned from an origin reports its branch and its ahead/behind pair, and
// pullFromOrigin fast-forwards it.
test("originSync reports the checkout's standing against origin, pullFromOrigin advances it (#71)", async () => {
  const upstream = initGitRepo();
  await git(upstream, ["config", "user.email", "t@t.local"]);
  await git(upstream, ["config", "user.name", "tester"]);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "base"]);

  const clonePath = join(HOME, "origin-sync-clone");
  await git(upstream, ["clone", "-q", upstream, clonePath]);
  await svc.repos.create({ path: clonePath, name: "me/origin-sync" });

  expect(await svc.repos.originSync("me/origin-sync")).toEqual({
    has_origin: true,
    branch: "main",
    ahead: 0,
    behind: 0,
  });

  writeFileSync(join(upstream, "next.txt"), "next\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "next"]);
  await git(clonePath, ["fetch", "-q", "origin"]);
  expect(await svc.repos.originSync("me/origin-sync")).toMatchObject({
    ahead: 0,
    behind: 1,
  });

  expect(await svc.repos.pullFromOrigin("me/origin-sync")).toEqual({
    has_origin: true,
    branch: "main",
    ahead: 0,
    behind: 0,
  });
  expect(
    S.getRepoById((await svc.repos.get("me/origin-sync")).id),
  ).toMatchObject({
    origin_branch: "main",
    origin_ahead: 0,
    origin_behind: 0,
  });
  expect(existsSync(join(clonePath, "next.txt"))).toBe(true);

  // The persisted projection is an eager write for consumers that need it, but originSync keeps
  // its existing live-ref behavior when another process advances the remote-tracking ref.
  writeFileSync(join(upstream, "later.txt"), "later\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "later"]);
  await git(clonePath, ["fetch", "-q", "origin"]);
  expect(await svc.repos.originSync("me/origin-sync")).toMatchObject({
    ahead: 0,
    behind: 1,
  });
});

// #71: without an origin there is nothing to sync — the repo top hides the section rather than
// offering a Pull that could only fail, and the procedure says why.
test("originSync reports no origin, and pullFromOrigin refuses without one (#71)", async () => {
  await svc.repos.create({ path: initGitRepo(), name: "me/no-origin" });

  expect(await svc.repos.originSync("me/no-origin")).toEqual({
    has_origin: false,
    branch: null,
    ahead: null,
    behind: null,
  });
  await expect(svc.repos.pullFromOrigin("me/no-origin")).rejects.toThrow(
    /no origin remote is configured/,
  );
});

// #71: a diverged branch has no fast-forward; git's own message is what the operator sees.
test("pullFromOrigin surfaces git's message when the branch has diverged (#71)", async () => {
  const upstream = initGitRepo();
  await git(upstream, ["config", "user.email", "t@t.local"]);
  await git(upstream, ["config", "user.name", "tester"]);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "base"]);

  const clonePath = join(HOME, "diverged-clone");
  await git(upstream, ["clone", "-q", upstream, clonePath]);
  await git(clonePath, ["config", "user.email", "t@t.local"]);
  await git(clonePath, ["config", "user.name", "tester"]);
  await svc.repos.create({ path: clonePath, name: "me/diverged" });

  writeFileSync(join(clonePath, "local.txt"), "local\n");
  await git(clonePath, ["add", "-A"]);
  await git(clonePath, ["commit", "-qm", "local"]);
  writeFileSync(join(upstream, "remote.txt"), "remote\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "remote"]);

  await expect(svc.repos.pullFromOrigin("me/diverged")).rejects.toThrow(
    /git pull --ff-only origin main failed/,
  );

  // The local commit is still the branch tip: the refused pull changed nothing.
  expect(await svc.repos.originSync("me/diverged")).toMatchObject({
    branch: "main",
    ahead: 1,
  });
});

// #71: a detached HEAD has no branch to compare or pull into.
test("originSync reports a detached HEAD, and pullFromOrigin refuses it (#71)", async () => {
  const upstream = initGitRepo();
  await git(upstream, ["config", "user.email", "t@t.local"]);
  await git(upstream, ["config", "user.name", "tester"]);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "base"]);

  const clonePath = join(HOME, "detached-clone");
  await git(upstream, ["clone", "-q", upstream, clonePath]);
  await git(clonePath, ["checkout", "-q", "--detach", "HEAD"]);
  await svc.repos.create({ path: clonePath, name: "me/detached" });

  expect(await svc.repos.originSync("me/detached")).toEqual({
    has_origin: true,
    branch: null,
    ahead: null,
    behind: null,
  });
  await expect(svc.repos.pullFromOrigin("me/detached")).rejects.toThrow(
    /HEAD is detached/,
  );
});

// #71: fetchFromOrigin refreshes the remote-tracking refs the counts come from without touching
// the checkout — the sync state it returns reflects the new upstream tip, and the branch and
// working tree stay put.
test("fetchFromOrigin refreshes the behind count without moving the checkout (#71)", async () => {
  const upstream = initGitRepo();
  await git(upstream, ["config", "user.email", "t@t.local"]);
  await git(upstream, ["config", "user.name", "tester"]);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "base"]);

  const clonePath = join(HOME, "fetch-clone");
  await git(upstream, ["clone", "-q", upstream, clonePath]);
  await git(clonePath, ["config", "user.email", "t@t.local"]);
  await git(clonePath, ["config", "user.name", "tester"]);
  await svc.repos.create({ path: clonePath, name: "me/fetch-clone" });

  const baseSha = (await git(clonePath, ["rev-parse", "HEAD"])).stdout.trim();

  writeFileSync(join(upstream, "next.txt"), "next\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "next"]);

  // Stale before the fetch.
  expect(await svc.repos.originSync("me/fetch-clone")).toMatchObject({
    ahead: 0,
    behind: 0,
  });

  expect(await svc.repos.fetchFromOrigin("me/fetch-clone")).toEqual({
    has_origin: true,
    branch: "main",
    ahead: 0,
    behind: 1,
  });
  // The checkout's branch and working tree are untouched.
  expect((await git(clonePath, ["rev-parse", "HEAD"])).stdout.trim()).toBe(
    baseSha,
  );
  expect(existsSync(join(clonePath, "next.txt"))).toBe(false);
});

// #71: fetch has no branch to move, only refs to refresh, so — unlike pull — it runs on a detached
// HEAD rather than refusing.
test("fetchFromOrigin runs on a detached HEAD (#71)", async () => {
  const upstream = initGitRepo();
  await git(upstream, ["config", "user.email", "t@t.local"]);
  await git(upstream, ["config", "user.name", "tester"]);
  writeFileSync(join(upstream, "f.txt"), "base\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "base"]);

  const clonePath = join(HOME, "fetch-detached-clone");
  await git(upstream, ["clone", "-q", upstream, clonePath]);
  await git(clonePath, ["checkout", "-q", "--detach", "HEAD"]);
  await svc.repos.create({ path: clonePath, name: "me/fetch-detached" });

  writeFileSync(join(upstream, "next.txt"), "next\n");
  await git(upstream, ["add", "-A"]);
  await git(upstream, ["commit", "-qm", "next"]);

  expect(await svc.repos.fetchFromOrigin("me/fetch-detached")).toEqual({
    has_origin: true,
    branch: null,
    ahead: null,
    behind: null,
  });
});

// #71: without an origin there is nothing to fetch, same as pull.
test("fetchFromOrigin refuses without an origin (#71)", async () => {
  await svc.repos.create({
    path: initGitRepo(),
    name: "me/fetch-no-origin",
  });
  await expect(svc.repos.fetchFromOrigin("me/fetch-no-origin")).rejects.toThrow(
    /no origin remote is configured/,
  );
});
