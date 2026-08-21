import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { BUILD_HASH_FILENAME, buildSpa, computeBuildHash } from "./build.ts";

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
  // The development entry is a source path a dev server would have to transform on demand.
  expect(indexHtml).not.toContain("/src/main.tsx");
});

test("the build emits processed styles, static assets, chunks, and source maps", () => {
  const assets = readdirSync(join(DIST, "assets"));
  const styles = assets
    .filter((name) => name.endsWith(".css"))
    .map((name) => readFileSync(join(DIST, "assets", name), "utf8"));
  expect(styles).toHaveLength(1);
  expect(styles[0]).toContain("--tw-");
  expect(styles[0]).not.toContain("@tailwind");
  expect(indexHtml).toContain(`<link rel="stylesheet" href="/assets/`);
  expect(existsSync(join(DIST, "favicon.svg"))).toBe(true);
  expect(assets.filter((name) => name.endsWith(".js")).length).toBeGreaterThan(
    1,
  );
  expect(assets.some((name) => name.endsWith(".js.map"))).toBe(true);
});

test("nothing in the build talks to a dev server", () => {
  const emitted = readdirSync(join(DIST, "assets")).map((name) =>
    readFileSync(join(DIST, "assets", name), "utf8"),
  );
  for (const source of [indexHtml, ...emitted]) {
    // A dev client's script tag, HMR socket, and transform hooks must not reach a page lh-web
    // serves.
    expect(source).not.toContain("@vite/client");
    expect(source).not.toContain("createHotContext");
    expect(source).not.toContain("vite-hmr");
  }
});

test("the build writes a .build-hash matching the current source", () => {
  const stored = readFileSync(join(DIST, BUILD_HASH_FILENAME), "utf8").trim();
  expect(stored).toBe(computeBuildHash());
});

test("an unchanged source tree skips the build", async () => {
  // beforeAll just built DIST, so the stored hash matches and buildSpa must not rebuild.
  expect(await buildSpa(DIST)).toBe(false);
});

test("a missing hash forces a rebuild", async () => {
  rmSync(join(DIST, BUILD_HASH_FILENAME), { force: true });
  expect(await buildSpa(DIST)).toBe(true);
  expect(readFileSync(join(DIST, BUILD_HASH_FILENAME), "utf8").trim()).toBe(
    computeBuildHash(),
  );
}, 180_000);

test("computeBuildHash changes when a hashed input changes", () => {
  const root = mkdtempSync(join(tmpdir(), "lh-build-hash-"));
  try {
    writeFileSync(join(root, "index.html"), "<h1>a</h1>");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "main.tsx"), "export const a = 1;");
    const before = computeBuildHash(root);

    // Unchanged inputs hash identically.
    expect(computeBuildHash(root)).toBe(before);

    // A change under a hashed directory (src) invalidates the hash.
    writeFileSync(join(root, "src", "main.tsx"), "export const a = 2;");
    expect(computeBuildHash(root)).not.toBe(before);

    // A change to a hashed file (index.html) invalidates it again.
    const afterSrc = computeBuildHash(root);
    writeFileSync(join(root, "index.html"), "<h1>b</h1>");
    expect(computeBuildHash(root)).not.toBe(afterSrc);

    // A missing input also invalidates the hash rather than being ignored silently.
    const afterBoth = computeBuildHash(root);
    rmSync(join(root, "index.html"));
    expect(computeBuildHash(root)).not.toBe(afterBoth);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
