const files = [] as string[];
const splitWithinFile = new Set([
  "src/components/pull-detail.test.tsx",
  "src/components/pull-diff-dialog.test.tsx",
]);
const FILE_BATCH_SIZE = 8;
const PATTERN_BATCH_SIZE = 4;
const singlePatternFiles = new Set([
  "src/components/pull-diff-dialog.test.tsx",
]);
for await (const file of new Bun.Glob("src/**/*.test.{ts,tsx}").scan({
  cwd: process.cwd(),
  onlyFiles: true,
})) {
  files.push(file);
}
files.sort();

if (files.length === 0) throw new Error("no Web test files discovered");

let tests = 0;
let peakChildRss = 0;
const startedAt = performance.now();
const batches: Array<{ files: string[]; pattern?: string }> = [];
for (const file of files) {
  if (splitWithinFile.has(file)) {
    const patterns = await testNamePatterns(file);
    if (patterns.length === 0)
      throw new Error(`no tests discovered for ${file}`);
    const patternBatchSize = singlePatternFiles.has(file)
      ? 1
      : PATTERN_BATCH_SIZE;
    for (let i = 0; i < patterns.length; i += patternBatchSize) {
      const patternBatch = patterns.slice(i, i + patternBatchSize);
      batches.push({
        files: [file],
        pattern: `(?:${patternBatch.join("|")})`,
      });
    }
    continue;
  }
  const previous = batches.at(-1);
  if (
    previous &&
    previous.pattern === undefined &&
    previous.files.length < FILE_BATCH_SIZE
  ) {
    previous.files.push(file);
  } else {
    batches.push({ files: [file] });
  }
}

for (const batch of batches) {
  const args = [
    process.execPath,
    "test",
    "--isolate",
    "--max-concurrency=1",
    "--preload",
    "./test-setup.ts",
    ...batch.files,
  ];
  if (batch.pattern) args.push(`--test-name-pattern=${batch.pattern}`);
  const result = Bun.spawnSync(args, {
    stderr: "pipe",
    stdout: "pipe",
  });
  peakChildRss = Math.max(peakChildRss, result.resourceUsage.maxRSS);
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  if (result.exitCode !== 0) process.exit(result.exitCode ?? 1);
  const match = `${stdout}\n${stderr}`.match(
    /Ran (\d+) tests? across (\d+) files?/,
  );
  if (!match)
    throw new Error(
      `test result summary missing for ${batch.files.join(", ")}`,
    );
  const batchTests = Number(match[1]);
  if (batchTests === 0)
    throw new Error(`no tests executed for ${batch.files.join(", ")}`);
  tests += batchTests;
  Bun.gc(true);
}

const seconds = ((performance.now() - startedAt) / 1_000).toFixed(2);
console.log(
  `Ran ${tests} tests across ${files.length} files. [${seconds}s, peak child RSS ${peakChildRss} bytes]`,
);

async function testNamePatterns(file: string): Promise<string[]> {
  const source = await Bun.file(file).text();
  const titles = [
    ...source.matchAll(/^\s*it\("((?:\\.|[^"])*)"/gm),
    ...source.matchAll(/it\.each\([\s\S]*?\)\("((?:\\.|[^"])*)"/g),
  ].map((match) => {
    const title = match[1];
    const placeholder = title.search(/%s|\$[A-Za-z_]\w*/);
    return (placeholder >= 0 ? title.slice(0, placeholder) : title).trim();
  });
  return [...new Set(titles)].map((title) =>
    title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
}
