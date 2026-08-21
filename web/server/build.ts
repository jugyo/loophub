// SPA build for lh-web. lh-web runs this once at startup and then serves the resulting web/dist
// as plain static files (http.ts's handleStatic): no dev client, no HMR WebSocket, so editing a
// source file cannot move the page someone is working in (#126). The cost is that a source change
// needs an lh-web restart to reach the browser.
// A restart rebuilds only when the source actually changed: the hash of the build inputs is
// stored next to the emitted assets (dist/.build-hash) and recomputed on startup. A matching
// hash means the dist is exactly what the current source produces, so the build is skipped and
// the restart is fast; anything else (no dist, no hash, or changed source) rebuilds.
// Kept out of http.ts so the HTTP core never imports the build tool and its tests stay build-free.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// web/ project root — holds the SPA entry, Tailwind config, and index.html.
const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SPA_ENTRY = join(WEB_ROOT, "src", "main.tsx");
const PUBLIC_DIR = join(WEB_ROOT, "public");

// Build inputs the emitted dist depends on. A change to any of these invalidates a stored hash;
// everything else (server/, other web/ configs) does not affect the SPA. The dist itself never
// feeds the hash. `src` is listed as a directory and hashed file by file.
const HASH_INPUTS = [
  "index.html",
  "package-lock.json",
  "tailwind.config.js",
  "public",
  "src",
] as const;

// Name of the hash file written into the dist root. A dist that carries a hash matching the
// current source is trusted to be up to date and served without rebuilding.
export const BUILD_HASH_FILENAME = ".build-hash";

const SOURCE_EXTENSIONS = ["", ".ts", ".tsx", ".js", ".jsx"] as const;

function resolveAlias(request: string): string {
  const base = join(WEB_ROOT, "src", request.slice(2));
  for (const extension of SOURCE_EXTENSIONS) {
    const path = `${base}${extension}`;
    if (existsSync(path)) return path;
  }
  return base;
}

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

function assetUrl(outDir: string, path: string): string {
  return `/${relative(outDir, path).split(sep).join("/")}`;
}

function writeIndexHtml(
  outDir: string,
  entryPath: string,
  cssPath: string,
): void {
  const sourceScript = '<script type="module" src="/src/main.tsx"></script>';
  const index = readFileSync(join(WEB_ROOT, "index.html"), "utf8");
  if (!index.includes(sourceScript)) {
    throw new Error("web/index.html is missing the SPA entry script");
  }
  const styles = `<link rel="stylesheet" href="${assetUrl(outDir, cssPath)}" />`;
  const script = `<script type="module" src="${assetUrl(outDir, entryPath)}"></script>`;
  writeFileSync(
    join(outDir, "index.html"),
    index.replace(sourceScript, `${styles}\n    ${script}`),
  );
}

function installBuild(staging: string, outDir: string): void {
  const previous = `${staging}-previous`;
  try {
    if (existsSync(outDir)) renameSync(outDir, previous);
    renameSync(staging, outDir);
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    if (!existsSync(outDir) && existsSync(previous))
      renameSync(previous, outDir);
    throw error;
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
  }
}

// Writes the SPA to `outDir` (default web/dist), replacing whatever an earlier run left there.
// Bun.build handles the browser module graph and PostCSS is applied through a Bun plugin so the
// existing Tailwind config remains the source of generated utilities. Building in a sibling
// directory first means a failed build leaves the previously emitted tree untouched, and the
// completed tree is installed as one unit. `outDir` exists so tests and packaging can build away
// from the directory a running lh-web is serving.
// Returns whether it actually built; `false` means the existing dist already matched the current
// source hash and was left untouched.
export async function buildSpa(outDir?: string): Promise<boolean> {
  const dist = outDir ?? join(WEB_ROOT, "dist");
  if (storedBuildHash(dist) === computeBuildHash()) return false;
  mkdirSync(dirname(dist), { recursive: true });
  const staging = mkdtempSync(join(dirname(dist), `.${basename(dist)}-`));
  try {
    const [
      { default: autoprefixer },
      { default: postcss },
      { default: tailwindcss },
    ] = await Promise.all([
      import("autoprefixer"),
      import("postcss"),
      import("tailwindcss"),
    ]);
    const result = await Bun.build({
      entrypoints: [SPA_ENTRY],
      outdir: staging,
      root: WEB_ROOT,
      minify: true,
      splitting: true,
      sourcemap: "external",
      target: "browser",
      naming: {
        entry: "assets/[name]-[hash].[ext]",
        chunk: "assets/[name]-[hash].[ext]",
        asset: "assets/[name]-[hash].[ext]",
      },
      plugins: [
        {
          name: "loophub-web-alias-and-postcss",
          target: "browser",
          setup(build) {
            build.onResolve({ filter: /^@\// }, (args) => ({
              path: resolveAlias(args.path),
            }));
            build.onLoad({ filter: /\.css$/ }, async ({ path }) => {
              const css = await Bun.file(path).text();
              const transformed = await postcss([
                tailwindcss({ config: join(WEB_ROOT, "tailwind.config.js") }),
                autoprefixer,
              ]).process(css, { from: path });
              return { contents: transformed.css, loader: "css" };
            });
          },
        },
      ],
    });
    if (!result.success) {
      throw new Error(
        result.logs.map((log) => log.message).join("\n") || "Bun.build failed",
      );
    }
    const entry = result.outputs.find(
      (output) => output.kind === "entry-point" && output.path.endsWith(".js"),
    );
    const css = result.outputs.find((output) => output.path.endsWith(".css"));
    if (!entry || !css) {
      throw new Error("Bun.build did not emit the SPA entry and stylesheet");
    }
    writeIndexHtml(staging, entry.path, css.path);
    if (existsSync(PUBLIC_DIR)) {
      cpPublicAssets(PUBLIC_DIR, staging);
    }
    writeFileSync(
      join(staging, BUILD_HASH_FILENAME),
      `${computeBuildHash()}\n`,
    );
    installBuild(staging, dist);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
  return true;
}

function cpPublicAssets(publicDir: string, outDir: string): void {
  for (const entry of readdirSync(publicDir)) {
    const source = join(publicDir, entry);
    const target = join(outDir, entry);
    if (statSync(source).isDirectory()) {
      mkdirSync(target, { recursive: true });
      cpPublicAssets(source, target);
    } else {
      writeFileSync(target, readFileSync(source));
    }
  }
}
