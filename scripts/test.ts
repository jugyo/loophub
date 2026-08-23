import { allTestFiles, gitIntegrationTestFiles } from "../test-files.ts";

const mode = Bun.argv[2] ?? "fast";
const isIntegration = mode === "integration";
const isFull = mode === "full";
const isWatch = mode === "watch";
if (!isIntegration && !isFull && !isWatch && mode !== "fast") {
  throw new Error(`unknown test mode: ${mode}`);
}

const files = isIntegration
  ? gitIntegrationTestFiles
  : await expandTestFiles(allTestFiles, isFull ? [] : gitIntegrationTestFiles);
if (files.length === 0) throw new Error("no test files discovered");
const args = [
  "test",
  "--isolate",
  "--max-concurrency=1",
  "--preload",
  "./test-setup.ts",
];
if (isWatch) args.push("--watch");
if (!isIntegration && !isFull) {
  for (const file of gitIntegrationTestFiles) {
    args.push("--path-ignore-patterns", file);
  }
}
args.push(...files);

const result = Bun.spawnSync([process.execPath, ...args], {
  stderr: "inherit",
  stdout: "inherit",
});
process.exit(result.exitCode ?? 1);

async function expandTestFiles(
  patterns: string[],
  excluded: string[],
): Promise<string[]> {
  const excludedSet = new Set(excluded);
  const files = new Set<string>();
  for (const pattern of patterns) {
    for await (const file of new Bun.Glob(pattern).scan({
      cwd: process.cwd(),
      onlyFiles: true,
    })) {
      if (!excludedSet.has(file)) files.add(file);
    }
  }
  return [...files].sort();
}
