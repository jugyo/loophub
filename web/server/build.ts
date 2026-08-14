// SPA build for lh-web. lh-web runs this once at startup and then serves the resulting web/dist
// as plain static files (http.ts's handleStatic): no Vite middleware, no dev client, no HMR
// WebSocket, so editing a source file cannot move the page someone is working in (#126). The
// cost is that a source change needs an lh-web restart to reach the browser.
// A restart rebuilds only when the source actually changed: the hash of the build inputs is
// stored next to the emitted assets (dist/.build-hash) and recomputed on startup. A matching
// hash means the dist is exactly what the current source produces, so the build is skipped and
// the restart is fast; anything else (no dist, no hash, or changed source) rebuilds.
// Kept out of http.ts so the HTTP core never imports Vite and its tests stay Vite-free.
// `vite` is imported dynamically: it is only needed when actually building.
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// web/ project root — holds vite.config.ts and index.html.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Build inputs the emitted dist depends on. A change to any of these invalidates a stored hash;
// everything else (server/, other web/ configs) does not affect the SPA. The dist itself never
// feeds the hash. `src` is listed as a directory and hashed file by file.
const HASH_INPUTS = [
  "index.html",
  "vite.config.ts",
  "package-lock.json",
  "src",
] as const;

// Name of the hash file written into the dist root. A dist that carries a hash matching the
// current source is trusted to be up to date and served without rebuilding.
export const BUILD_HASH_FILENAME = ".build-hash";

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files;
}

// Hash of the current build inputs. `root` only exists so tests can hash a throwaway directory
// tree instead of the real web/; production callers use the default. Missing inputs are skipped,
// so a checkout that has not run `npm install` still hashes the same way on every restart. The
// result is independent of directory-listing order thanks to the sort below.
export function computeBuildHash(root: string = WEB_ROOT): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const input of HASH_INPUTS) {
    const path = join(root, input);
    if (!existsSync(path)) continue;
    if (statSync(path).isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  for (const file of files.sort()) {
    // Path and content are separated with NUL so "a/b" + "c" cannot collide with "a" + "b/c".
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function storedBuildHash(dist: string): string | null {
  const path = join(dist, BUILD_HASH_FILENAME);
  return existsSync(path) ? readFileSync(path, "utf8").trim() || null : null;
}

// Writes the SPA to `outDir` (default web/dist), replacing whatever an earlier run left there.
// Vite's own build log goes to this process's stdout, which is where the few seconds it takes are
// accounted for. `outDir` exists so a caller can build somewhere other than the directory a
// running lh-web is serving: replacing those files under a live process breaks the chunks its
// open tabs still lazy-import, which is the kind of accident this whole change is about avoiding.
// Returns whether it actually built; `false` means the existing dist already matched the current
// source hash and was left untouched.
export async function buildSpa(outDir?: string): Promise<boolean> {
  const dist = outDir ?? join(WEB_ROOT, "dist");
  if (storedBuildHash(dist) === computeBuildHash()) return false;
  const { build } = await import("vite");
  await build({
    root: WEB_ROOT,
    ...(outDir ? { build: { outDir, emptyOutDir: true } } : {}),
  });
  writeFileSync(join(dist, BUILD_HASH_FILENAME), `${computeBuildHash()}\n`);
  return true;
}
