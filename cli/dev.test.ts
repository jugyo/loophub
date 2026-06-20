import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI = join(import.meta.dirname, "index.ts");

// `lh dev` resolves --repo locally (no DB access), so --print needs no HOME/DB setup.
function dev(args: string[]) {
  const r = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "--disable-warning=ExperimentalWarning", "--import", "tsx", CLI, "dev", ...args],
    { encoding: "utf8" },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

test("--print emits one shell-pasteable claude line with a generated session-id", () => {
  const { stdout, stderr, exitCode } = dev(["181", "--repo", "jugyo/local-github", "--print"]);
  expect(exitCode).toBe(0);
  const lines = stdout.trim().split("\n");
  expect(lines).toHaveLength(1);
  const m = lines[0].match(
    /^claude --session-id ([0-9a-f-]{36}) --managed-settings '(.+)' '\/loophub-dev 181'$/,
  );
  expect(m).not.toBeNull();
  const settings = JSON.parse(m![2]);
  expect(settings.sandbox.enabled).toBe(true);
  expect(settings.sandbox.allowUnsandboxedCommands).toBe(false);
  expect(settings.sandbox.network.allowManagedDomainsOnly).toBe(true);
  expect(settings.sandbox.network.allowedDomains).toEqual(["api.anthropic.com", "github.com"]);
  expect(stderr).toContain("repo: jugyo/local-github");
  expect(stderr).toContain("allowed-domains: api.anthropic.com, github.com");
  expect(stderr).not.toContain("exec:");
});

test("--allow unions validated domains into the proxy allow-list", () => {
  const { stdout } = dev(["7", "--repo", "me/proj", "--allow", "example.com,*.test.dev", "--print"]);
  const json = stdout.match(/--managed-settings '(.+)' '/)![1];
  expect(JSON.parse(json).sandbox.network.allowedDomains).toEqual([
    "api.anthropic.com",
    "github.com",
    "example.com",
    "*.test.dev",
  ]);
});

test("each invocation generates a distinct session-id", () => {
  const a = dev(["1", "--repo", "me/proj", "--print"]);
  const b = dev(["1", "--repo", "me/proj", "--print"]);
  const id = (s: string) => s.match(/--session-id ([0-9a-f-]{36})/)![1];
  expect(id(a.stdout)).not.toBe(id(b.stdout));
});

test("missing issue number prints usage and exits non-zero", () => {
  const { stderr, exitCode } = dev(["--repo", "me/proj"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("usage: lh dev <issue>");
});

test("non-numeric issue number is rejected", () => {
  expect(dev(["foo", "--repo", "me/proj"]).exitCode).not.toBe(0);
});

test("invalid --allow domain is rejected (injection guard)", () => {
  const { stderr, exitCode } = dev(["1", "--repo", "me/proj", "--allow", 'evil",":', "--print"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("invalid --allow domain");
});

test("invalid --repo is rejected", () => {
  const { stderr, exitCode } = dev(["1", "--repo", "not-a-repo", "--print"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("invalid --repo");
});

test("--verbose adds the full exec line to stderr", () => {
  const { stdout, stderr, exitCode } = dev([
    "42",
    "--repo",
    "me/proj",
    "--allow",
    "example.com",
    "--print",
    "--verbose",
  ]);
  expect(exitCode).toBe(0);
  expect(stdout.trim().split("\n")).toHaveLength(1);
  expect(stderr).toContain("allowed-domains: api.anthropic.com, github.com, example.com");
  expect(stderr).toContain(`exec: ${stdout.trim()}`);
});
