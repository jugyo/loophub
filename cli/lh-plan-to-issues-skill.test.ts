import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";

const skill = readFileSync(
  join(import.meta.dirname, "..", "skills", "lh-plan-to-issues", "SKILL.md"),
  "utf8",
);

test("lh-plan-to-issues stores acceptance criteria separately from issue bodies", () => {
  const bodyTemplate = skill.slice(
    skill.indexOf("## Issue body template"),
    skill.indexOf("## Follow-on work"),
  );

  expect(bodyTemplate).not.toContain("## Acceptance criteria");
  expect(skill).toContain(
    "Pass every acceptance criterion as a separate repeatable `--ac` value",
  );
  expect(skill).toContain(
    "Do not add\nan acceptance-criteria heading or duplicate checklist to `--body`",
  );
  expect(skill).toContain("lh issue create --help");
});
