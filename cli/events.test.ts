import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

function runEvents(flag: "--follow" | "-f") {
  return spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "cli/index.ts",
      "events",
      flag,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

describe("lh events removed follow flags", () => {
  for (const flag of ["--follow", "-f"] as const) {
    it(`rejects ${flag} instead of silently running a snapshot`, () => {
      const result = runEvents(flag);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`${flag} was removed`);
      expect(result.stderr).toContain("lh events --since <id> --order asc");
    });
  }
});
