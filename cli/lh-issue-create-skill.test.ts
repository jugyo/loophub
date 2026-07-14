import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const skill = readFileSync(
  join(import.meta.dirname, "..", "skills", "lh-issue-create", "SKILL.md"),
  "utf8",
);

test("lh-issue-create allows natural title word order in the conversation language", () => {
  const questionMode = skill.slice(
    skill.indexOf("### Question mode"),
    skill.indexOf("## LoopHub"),
  );
  const procedure = skill.slice(
    skill.indexOf("## Procedure"),
    skill.indexOf("#### Related resources"),
  );

  expect(questionMode).toContain("- **Title candidate** (one line)");
  expect(procedure).toContain("- **Title candidate** (one line)");
  expect(skill).toContain("must match the\nuser's **conversation language**");
  expect(skill).not.toMatch(/starts? with (?:a )?verb/i);
  expect(skill).not.toMatch(/(?:verb|動詞)\s*:\s*(?:body|本文)/i);
});

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

test("lh-issue-create records user-mentioned related resources", () => {
  expect(skill).toContain(
    "**Related resources explicitly mentioned by the user**",
  );
  expect(skill).toContain("resource type, reference, and known relationship");
  expect(skill).toMatch(/GitHub,\s+Notion, or Slack/);
  expect(skill).toContain("other services and local materials");
  expect(skill).toContain("## Related resources");
});

test("lh-issue-create does not invent missing related resources", () => {
  expect(skill).toContain(
    "Do not search for, infer, or fabricate related resources",
  );
  expect(skill).toContain("None mentioned");
  expect(skill).toMatch(
    /A resource name,\s+channel, page, issue or PR number, URL, or local path is itself a valid reference/,
  );
});

test("lh-issue-create includes a concrete related-resources example", () => {
  expect(skill).toContain("### Example with related resources");
  expect(skill).toContain("GitHub issue — `acme/widget#42`");
  expect(skill).toContain("Slack channel — `#release-ops`");
  expect(skill).toContain("Local document — `docs/release-plan.md`");
});

test("lh-issue-create relies on automatic current-pane association", () => {
  expect(skill).toContain(
    "`lh issue create` automatically associates the created Issue with the current Herdr pane",
  );
  expect(skill).toContain("Do not pass a pane-linking flag");
  expect(skill).not.toContain("HERDR_ENV");
  expect(skill).not.toMatch(/\bherdr (?:agent|pane|tab|workspace)\b/);
  expect(skill).not.toMatch(/--(?:link|pane|herdr-(?:pane|session))/);
});
