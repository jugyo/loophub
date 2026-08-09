import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildSpa } from "./build.ts";

// Never web/dist: an lh-web may be running out of it, and replacing those files under it breaks
// the chunks its open tabs still lazy-import.
const DIST = mkdtempSync(join(tmpdir(), "lh-web-dist-"));

let indexHtml: string;

beforeAll(async () => {
  await buildSpa(DIST);
  indexHtml = readFileSync(join(DIST, "index.html"), "utf8");
}, 180_000);

afterAll(() => {
  rmSync(DIST, { recursive: true, force: true });
});

test("the built page loads the app from a bundled asset", () => {
  const entry = indexHtml.match(
    /<script type="module"[^>]*src="(\/assets\/[^"]+)"/,
  )?.[1];
  expect(entry).toBeDefined();
  expect(existsSync(join(DIST, entry as string))).toBe(true);
  // The dev entry is a source path Vite would have to transform on demand.
  expect(indexHtml).not.toContain("/src/main.tsx");
});

test("nothing in the build talks to a dev server", () => {
  const emitted = readdirSync(join(DIST, "assets")).map((name) =>
    readFileSync(join(DIST, "assets", name), "utf8"),
  );
  for (const source of [indexHtml, ...emitted]) {
    // Vite's dev client — the script tag it injects, the HMR socket it opens, and the hooks dev
    // transforms import from it. None of it may reach a page lh-web serves.
    expect(source).not.toContain("@vite/client");
    expect(source).not.toContain("createHotContext");
    expect(source).not.toContain("vite-hmr");
  }
});
