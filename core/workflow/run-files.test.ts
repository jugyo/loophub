import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

const HOME = mkdtempSync(join(tmpdir(), "lh-workflow-run-files-"));
const OUTSIDE = mkdtempSync(join(tmpdir(), "lh-workflow-run-files-outside-"));
process.env.LOOPHUB_HOME = HOME;

let F: typeof import("./run-files.ts");

beforeAll(async () => {
  F = await import("./run-files.ts");
});

afterEach(() => {
  rmSync(join(HOME, "runs"), { recursive: true, force: true });
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

test("contract writers create run-scoped files under LOOPHUB_HOME", () => {
  const parent = F.writeParentContract(7, "# Parent\n");
  const execute = F.writeStepContract(7, "execute", "# Execute\n");
  const verify = F.writeStepContract(7, "verify", "# Verify\n");

  expect(parent).toBe(
    join(HOME, "runs", "workflow", "7", "parent-contract.md"),
  );
  expect(execute).toBe(
    join(HOME, "runs", "workflow", "7", "execute-contract.md"),
  );
  expect(verify).toBe(
    join(HOME, "runs", "workflow", "7", "verify-contract.md"),
  );
  expect(readFileSync(parent, "utf8")).toBe("# Parent\n");
  expect(readFileSync(execute, "utf8")).toBe("# Execute\n");
  expect(lstatSync(parent).mode & 0o777).toBe(0o600);
});

test("prompt writers sit beside the contracts in the same run dir", () => {
  const parent = F.writeParentPrompt(7, "## Run context\n");
  const execute = F.writeStepPrompt(7, "execute", "## Inputs\n");

  expect(parent).toBe(join(HOME, "runs", "workflow", "7", "parent-prompt.md"));
  expect(execute).toBe(
    join(HOME, "runs", "workflow", "7", "execute-prompt.md"),
  );
  expect(readFileSync(parent, "utf8")).toBe("## Run context\n");
  expect(readFileSync(execute, "utf8")).toBe("## Inputs\n");
});

test("concurrent step launches keep immutable session-scoped inputs", () => {
  const firstSession = "11111111-1111-4111-8111-111111111111";
  const secondSession = "22222222-2222-4222-8222-222222222222";
  const firstContract = F.writeStepLaunchContract(
    7,
    firstSession,
    "verify",
    "# First contract\n",
  );
  const firstPrompt = F.writeStepLaunchPrompt(
    7,
    firstSession,
    "verify",
    "## First prompt\n",
  );
  const secondContract = F.writeStepLaunchContract(
    7,
    secondSession,
    "verify",
    "# Second contract\n",
  );
  const secondPrompt = F.writeStepLaunchPrompt(
    7,
    secondSession,
    "verify",
    "## Second prompt\n",
  );

  expect(firstContract).not.toBe(secondContract);
  expect(firstPrompt).not.toBe(secondPrompt);
  expect(readFileSync(firstContract, "utf8")).toBe("# First contract\n");
  expect(readFileSync(firstPrompt, "utf8")).toBe("## First prompt\n");
  expect(readFileSync(secondContract, "utf8")).toBe("# Second contract\n");
  expect(readFileSync(secondPrompt, "utf8")).toBe("## Second prompt\n");
});

test("a rewrite truncates the previous contract instead of appending", () => {
  F.writeStepContract(8, "execute", "# Long first contract\n");
  const path = F.writeStepContract(8, "execute", "# Short\n");
  expect(readFileSync(path, "utf8")).toBe("# Short\n");
});

// The symlink guard: every directory level the writer would create or reuse must be a real
// directory. A symlink anywhere on the path could redirect a 0600 contract write outside
// LOOPHUB_HOME, so the writer refuses rather than following it.
test.each([
  ["runs", () => join(HOME, "runs")],
  ["runs/workflow", () => join(HOME, "runs", "workflow")],
  ["the run dir", () => join(HOME, "runs", "workflow", "9")],
])("a symlinked %s is rejected, not followed", (_label, symlinkPath) => {
  const path = symlinkPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const target = mkdtempSync(join(OUTSIDE, "target-"));
  symlinkSync(target, path);

  expect(() => F.writeParentContract(9, "# Parent\n")).toThrow(
    /must not be a symlink/,
  );
  expect(() => F.writeParentPrompt(9, "# Parent\n")).toThrow(
    /must not be a symlink/,
  );
  expect(() => readFileSync(join(target, "parent-contract.md"))).toThrow();
});

test("a symlinked contract file is rejected, not followed", () => {
  const dir = join(HOME, "runs", "workflow", "10");
  mkdirSync(dir, { recursive: true });
  const target = join(OUTSIDE, "victim.md");
  symlinkSync(target, join(dir, "parent-contract.md"));

  expect(() => F.writeParentContract(10, "# Parent\n")).toThrow(
    expect.objectContaining({ code: "ELOOP" }),
  );
  expect(() => readFileSync(target)).toThrow();
});
