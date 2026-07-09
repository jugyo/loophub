import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const skill = readFileSync(
  join(import.meta.dirname, "..", "skills", "lh-issue-create", "SKILL.md"),
  "utf8",
);

test("lh-issue-create target branch guidance is explicit and metadata-only", () => {
  expect(skill).toContain("creates implementation branches");
  expect(skill).toContain("Target-branch exception");
  expect(skill).toContain("issue metadata preparation");
  expect(skill).toContain("Do **not** infer or invent a target branch");
  expect(skill).toContain("omit `--target-branch` entirely");
  expect(skill).toMatch(
    /`lh issue create --target-branch <branch> --create-target-branch` may create that local target\s+branch/,
  );
});

test("lh-issue-create target branch shell guidance treats branch names as untrusted", () => {
  expect(skill).toContain("Treat the branch name as untrusted command data");
  expect(skill).toMatch(/do not paste raw branch text\s+into a shell command/);
  expect(skill).toContain("Use an argv-native tool call when available");
  expect(skill).not.toContain(
    '--target-branch "<branch>" --create-target-branch',
  );
});
