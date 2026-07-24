import { spawnSync } from "node:child_process";
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
