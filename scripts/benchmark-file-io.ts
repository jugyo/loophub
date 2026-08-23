import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

type BenchmarkKind = "build-skip" | "build-rebuild" | "attachment";
type BenchmarkResult = {
  kind: BenchmarkKind;
  mode: "before" | "after";
  wall_ms: number;
  peak_rss_mib: number;
  rss_delta_mib: number;
  artifact_digest?: string;
  artifact_files?: string[];
  build_hash?: string;
  upload_ms?: number;
  download_ms?: number;
  upload_peak_rss_mib?: number;
  download_peak_rss_mib?: number;
  received_bytes?: number;
  received_sha256?: string;
  expected_sha256?: string;
};

const argv = process.argv.slice(2);
const argValue = (name: string, fallback?: string): string | undefined => {
  const index = argv.indexOf(name);
  return index < 0 ? fallback : argv[index + 1];
};
const workerKind = argValue("--worker") as BenchmarkKind | undefined;
const sourceRoot = resolve(argValue("--source-root", process.cwd())!);
const mode = (argValue("--mode", "after") as "before" | "after") ?? "after";
const trials = Number(argValue("--trials", "5"));

function rss(): number {
  return process.memoryUsage().rss;
}

async function measured<T>(operation: () => Promise<T>): Promise<{
  result: T;
  wallMs: number;
  peakRss: number;
  rssDelta: number;
}> {
  Bun.gc(true);
  const startRss = rss();
  let peakRss = startRss;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, rss());
  }, 1);
  const started = performance.now();
  try {
    const result = await operation();
    peakRss = Math.max(peakRss, rss());
    return {
      result,
      wallMs: performance.now() - started,
      peakRss,
      rssDelta: peakRss - startRss,
    };
  } finally {
    clearInterval(sampler);
  }
}

function listFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? listFiles(path) : [path];
  });
}

async function artifactManifest(dist: string): Promise<string[]> {
  const entries: string[] = [];
  for (const file of listFiles(dist).sort()) {
    const rel = relative(dist, file).replace(
      /-[A-Za-z0-9]{8,}(?=\.(?:js|css)(?:\.map)?$)/g,
      "",
    );
    let content = Buffer.from(await Bun.file(file).arrayBuffer());
    if (rel.endsWith(".map")) {
      const map = JSON.parse(content.toString("utf8")) as {
        sourceRoot?: string;
        sources?: string[];
        file?: string;
        debugId?: string;
        [key: string]: unknown;
      };
      delete map.sourceRoot;
      delete map.debugId;
      map.file = "<file>";
      if (map.sources) {
        map.sources = map.sources.map((source) => source.split(/[\\/]/).pop()!);
      }
      content = Buffer.from(JSON.stringify(map));
    } else if (rel.endsWith(".js") || rel.endsWith(".html")) {
      content = Buffer.from(
        content
          .toString("utf8")
          .replaceAll(/assets\/[^\s"'`]+\.(?:js|css|map)/g, "assets/<asset>")
          .replaceAll(/sourceMappingURL=[^\s]+/g, "sourceMappingURL=<map>")
          .replaceAll(/debugId=[^\s]+/g, "debugId=<debug-id>")
          .replaceAll(
            /[A-Za-z0-9_.-]+-[A-Za-z0-9]{8,}\.js(?:\.map)?/g,
            "<asset>",
          ),
      );
    }
    const type = rel.endsWith(".map")
      ? "map"
      : rel.endsWith(".js")
        ? "js"
        : rel.endsWith(".css")
          ? "css"
          : rel;
    entries.push(
      `${type}:${createHash("sha256").update(content).digest("hex")}`,
    );
  }
  return entries.sort();
}

async function artifactDigest(dist: string): Promise<{
  digest: string;
  files: string[];
}> {
  const hash = createHash("sha256");
  const files = await artifactManifest(dist);
  for (const entry of files) {
    const [rel, digest] = entry.split(":");
    hash.update(rel);
    hash.update("\0");
    hash.update(digest);
    hash.update("\0");
  }
  return { digest: hash.digest("hex"), files };
}

async function buildResult(
  kind: "build-skip" | "build-rebuild",
): Promise<BenchmarkResult> {
  const home = mkdtempSync(join(tmpdir(), "lh-build-benchmark-"));
  process.env.LOOPHUB_HOME = home;
  process.env.LOOPHUB_DB = join(home, "loophub.db");
  const { buildSpa } = await import(
    new URL(`../web/server/build.ts`, import.meta.url).href.replace(
      `${resolve(import.meta.dir, "..")}/`,
      `${sourceRoot}/`,
    )
  );
  const dist = join(home, "dist");
  if (kind === "build-skip") await buildSpa(dist);
  const measuredBuild = await measured(() => buildSpa(dist));
  if (kind === "build-skip" && measuredBuild.result) {
    throw new Error("build skip benchmark rebuilt unexpectedly");
  }
  if (kind === "build-rebuild" && !measuredBuild.result) {
    throw new Error("build rebuild benchmark skipped unexpectedly");
  }
  const artifacts = await artifactDigest(dist);
  const result: BenchmarkResult = {
    kind,
    mode,
    wall_ms: measuredBuild.wallMs,
    peak_rss_mib: measuredBuild.peakRss / 1024 / 1024,
    rss_delta_mib: measuredBuild.rssDelta / 1024 / 1024,
    artifact_digest: artifacts.digest,
    artifact_files: artifacts.files,
    build_hash: (await Bun.file(join(dist, ".build-hash")).text()).trim(),
  };
  rmSync(home, { recursive: true, force: true });
  return result;
}

async function attachmentResult(): Promise<BenchmarkResult> {
  const home = mkdtempSync(join(tmpdir(), "lh-attachment-benchmark-"));
  process.env.LOOPHUB_HOME = home;
  process.env.LOOPHUB_DB = join(home, "loophub.db");
  const { createLhWebServer } = await import(
    new URL(`../web/server/http.ts`, import.meta.url).href.replace(
      `${resolve(import.meta.dir, "..")}/`,
      `${sourceRoot}/`,
    )
  );
  const server = createLhWebServer(() => new Response(null, { status: 404 }));
  const base = server.url.origin;
  const payload = Buffer.alloc(2 * 1024 * 1024, 0x5a);
  const expectedSha256 = createHash("sha256").update(payload).digest("hex");
  const upload = await measured(async () => {
    const response = await fetch(
      `${base}/attachments?filename=benchmark.png&actor=benchmark`,
      {
        method: "POST",
        headers: { "content-type": "image/png" },
        body: payload,
      },
    );
    if (response.status !== 201)
      throw new Error(`upload failed: ${response.status}`);
    return (await response.json()) as { url: string; sha256: string };
  });
  if (upload.result.sha256 !== expectedSha256) {
    throw new Error("upload SHA-256 did not match");
  }
  const download = await measured(async () => {
    const response = await fetch(`${base}${upload.result.url}`);
    if (response.status !== 200)
      throw new Error(`download failed: ${response.status}`);
    const received = Buffer.from(await response.arrayBuffer());
    return {
      bytes: received.length,
      sha256: createHash("sha256").update(received).digest("hex"),
    };
  });
  server.stop(true);
  const result: BenchmarkResult = {
    kind: "attachment",
    mode,
    wall_ms: upload.wallMs,
    peak_rss_mib: upload.peakRss / 1024 / 1024,
    rss_delta_mib: upload.rssDelta / 1024 / 1024,
    upload_ms: upload.wallMs,
    download_ms: download.wallMs,
    upload_peak_rss_mib: upload.peakRss / 1024 / 1024,
    download_peak_rss_mib: download.peakRss / 1024 / 1024,
    received_bytes: download.result.bytes,
    received_sha256: download.result.sha256,
    expected_sha256: expectedSha256,
  };
  rmSync(home, { recursive: true, force: true });
  return result;
}

async function runWorker(): Promise<void> {
  const result =
    workerKind === "attachment"
      ? await attachmentResult()
      : await buildResult(workerKind ?? "build-skip");
  console.log(JSON.stringify(result));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function range(values: number[]): { min: number; max: number } {
  return { min: Math.min(...values), max: Math.max(...values) };
}

async function runWorkerProcess(
  kind: BenchmarkKind,
  workerMode: "before" | "after",
  root: string,
): Promise<BenchmarkResult> {
  const processHandle = Bun.spawn(
    [
      process.execPath,
      import.meta.filename,
      "--worker",
      kind,
      "--mode",
      workerMode,
      "--source-root",
      root,
    ],
    { stdout: "pipe", stderr: "inherit" },
  );
  const output = await new Response(processHandle.stdout).text();
  const status = await processHandle.exited;
  if (status !== 0)
    throw new Error(`${kind}/${workerMode} benchmark exited with ${status}`);
  return JSON.parse(output.trim()) as BenchmarkResult;
}

async function runTrials(
  kind: BenchmarkKind,
  workerMode: "before" | "after",
  root: string,
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (let i = 0; i < trials; i++) {
    results.push(await runWorkerProcess(kind, workerMode, root));
  }
  return results;
}

function summarize(results: BenchmarkResult[]): Record<string, unknown> {
  const first = results[0];
  const summary: Record<string, unknown> = {
    mode: first.mode,
    kind: first.kind,
    trials: results.length,
    wall_ms_median: median(results.map((result) => result.wall_ms)),
    wall_ms_range: range(results.map((result) => result.wall_ms)),
    peak_rss_mib_median: median(results.map((result) => result.peak_rss_mib)),
    peak_rss_mib_range: range(results.map((result) => result.peak_rss_mib)),
    rss_delta_mib_median: median(results.map((result) => result.rss_delta_mib)),
  };
  if (first.kind === "attachment") {
    summary.upload_ms_median = median(
      results.map((result) => result.upload_ms!),
    );
    summary.upload_ms_range = range(results.map((result) => result.upload_ms!));
    summary.download_ms_median = median(
      results.map((result) => result.download_ms!),
    );
    summary.download_ms_range = range(
      results.map((result) => result.download_ms!),
    );
    summary.upload_peak_rss_mib_median = median(
      results.map((result) => result.upload_peak_rss_mib!),
    );
    summary.download_peak_rss_mib_median = median(
      results.map((result) => result.download_peak_rss_mib!),
    );
    summary.received_bytes = first.received_bytes;
    summary.received_sha256 = first.received_sha256;
    summary.expected_sha256 = first.expected_sha256;
  } else {
    summary.artifact_digest = first.artifact_digest;
    summary.build_hash = first.build_hash;
    if (
      results.some((result) => result.artifact_digest !== first.artifact_digest)
    ) {
      throw new Error(
        `${first.kind}/${first.mode} artifact digest varied between trials`,
      );
    }
    if (results.some((result) => result.build_hash !== first.build_hash)) {
      throw new Error(
        `${first.kind}/${first.mode} build hash varied between trials`,
      );
    }
  }
  return summary;
}

async function runParent(): Promise<void> {
  if (!Number.isInteger(trials) || trials < 3)
    throw new Error("--trials must be an integer >= 3");
  const repoRoot = resolve(import.meta.dir, "..");
  const beforeRef = argValue("--before-ref");
  let beforeRoot: string | undefined;
  try {
    if (beforeRef) {
      beforeRoot = mkdtempSync(join(tmpdir(), "lh-before-worktree-"));
      rmSync(beforeRoot, { recursive: true, force: true });
      const worktree = Bun.spawnSync([
        "git",
        "worktree",
        "add",
        "--detach",
        beforeRoot,
        beforeRef,
      ]);
      if (worktree.exitCode !== 0) throw new Error(worktree.stderr.toString());
      symlinkSync(
        join(repoRoot, "node_modules"),
        join(beforeRoot, "node_modules"),
        "dir",
      );
      mkdirSync(join(beforeRoot, "web"), { recursive: true });
      symlinkSync(
        join(repoRoot, "web/node_modules"),
        join(beforeRoot, "web/node_modules"),
        "dir",
      );
    }
    const before = beforeRoot ?? repoRoot;
    const afterSummaries = [];
    const beforeSummaries = [];
    for (const kind of ["build-skip", "build-rebuild", "attachment"] as const) {
      const beforeResults = await runTrials(kind, "before", before);
      const afterResults = await runTrials(kind, "after", repoRoot);
      beforeSummaries.push(summarize(beforeResults));
      afterSummaries.push(summarize(afterResults));
      if (kind === "attachment") {
        for (const result of [...beforeResults, ...afterResults]) {
          if (
            result.received_bytes !== 2 * 1024 * 1024 ||
            result.received_sha256 !== result.expected_sha256
          ) {
            throw new Error("attachment payload verification failed");
          }
        }
      } else if (
        beforeResults[0].artifact_digest !== afterResults[0].artifact_digest
      ) {
        throw new Error(
          `${kind} generated artifact digest differs before/after: ${JSON.stringify(
            beforeResults[0].artifact_files?.filter(
              (entry) => !afterResults[0].artifact_files?.includes(entry),
            ),
          )}`,
        );
      } else if (beforeResults[0].build_hash !== afterResults[0].build_hash) {
        throw new Error(`${kind} build hash differs before/after`);
      }
    }
    console.log(
      JSON.stringify(
        {
          command: `bun scripts/benchmark-file-io.ts --before-ref ${beforeRef ?? "<before-ref>"} --trials ${trials}`,
          environment: {
            bun: Bun.version,
            platform: process.platform,
            arch: process.arch,
            cpu_count: navigator.hardwareConcurrency,
          },
          before: beforeSummaries,
          after: afterSummaries,
        },
        null,
        2,
      ),
    );
  } finally {
    if (beforeRoot) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", beforeRoot]);
    }
  }
}

if (workerKind) await runWorker();
else await runParent();
