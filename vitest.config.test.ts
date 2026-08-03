import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

test("test processes do not inherit workflow session attribution", () => {
  expect(process.env.LOOPHUB_SESSION_ID).toBeUndefined();

  const child = spawnSync(
    process.execPath,
    ["-e", "process.stdout.write(process.env.LOOPHUB_SESSION_ID ?? 'unset')"],
    { encoding: "utf8", env: { ...process.env } },
  );
  expect(child.status).toBe(0);
  expect(child.stdout).toBe("unset");
});

test("root test scripts include the Web SPA suite", () => {
  const packageJSON = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };

  expect(packageJSON.scripts["test:web"]).toBe("npm --prefix web test");
  expect(packageJSON.scripts.test).toContain("npm run test:web");
  expect(packageJSON.scripts["test:full"]).toContain("npm run test:web");
});
