import { readFileSync } from "node:fs";
import { expect, test } from "#loophub-test";

test("root test scripts include the Web SPA suite", () => {
  const packageJSON = JSON.parse(
    readFileSync(new URL("./package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };

  expect(packageJSON.scripts["test:web"]).toBe("bun --cwd web test");
  expect(packageJSON.scripts.test).toContain("bun run test:web");
  expect(packageJSON.scripts["test:full"]).toContain("bun run test:web");
});
