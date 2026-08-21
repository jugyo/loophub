#!/usr/bin/env bun
// Compile LoopHub into the single self-contained executable described in bin/loophub.ts.
//
//   bun scripts/build-binary.ts [--out <dir>] [--target <bun target>] [--skip-spa]
//
// The executable carries `lh`, `lh-web` and every worker, so a machine running LoopHub needs no
// Node, no Bun and no node_modules. The SPA is not compiled into it: Bun builds the assets here
// and they are copied next to the executable, where lh-web looks for them (core/self-exec.ts).
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSpa } from "../web/server/build.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "bin", "loophub.ts");

const argv = process.argv.slice(2);
let outDir = join(ROOT, "dist");
let target: string | undefined;
let skipSpa = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") outDir = resolve(argv[++i] ?? "");
  else if (argv[i] === "--target") target = argv[++i];
  else if (argv[i] === "--skip-spa") skipSpa = true;
  else {
    process.stderr.write(`build-binary: unknown option ${argv[i]}\n`);
    process.exit(1);
  }
}

const binaryName = target?.includes("windows") ? "loophub.exe" : "loophub";
const binaryPath = join(outDir, binaryName);
const spaOut = join(outDir, "web", "dist");

if (!skipSpa) {
  process.stdout.write("build-binary: building the SPA\n");
  await buildSpa();
}

mkdirSync(outDir, { recursive: true });
// The SPA build dependencies are imported dynamically by web/server/build.ts and are only
// reachable from the checkout; the binary skips that path entirely, so keep the bundler from
// pulling them (and their dependency trees) into the executable.
const compile = spawnSync(
  "bun",
  [
    "build",
    "--compile",
    "--external",
    "autoprefixer",
    "--external",
    "postcss",
    "--external",
    "tailwindcss",
    ...(target ? ["--target", target] : []),
    "--outfile",
    binaryPath,
    ENTRY,
  ],
  { cwd: ROOT, stdio: "inherit" },
);
if (compile.status !== 0) process.exit(compile.status ?? 1);

rmSync(spaOut, { recursive: true, force: true });
cpSync(join(ROOT, "web", "dist"), spaOut, { recursive: true });

const megabytes = (statSync(binaryPath).size / 1024 ** 2).toFixed(1);
process.stdout.write(
  `build-binary: ${binaryPath} (${megabytes} MB)\n` +
    `build-binary: SPA assets at ${spaOut}\n` +
    `build-binary: run \`${binaryPath} --roles\` to list the processes it serves\n`,
);
