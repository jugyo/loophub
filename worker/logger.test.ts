import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, expect, test, vi } from "vitest";

const home = mkdtempSync(join(tmpdir(), "lh-worker-log-"));
const previousHome = process.env.LOOPHUB_HOME;
process.env.LOOPHUB_HOME = home;

const {
  sanitizeWorkerLogMessage,
  workerErrorDetail,
  workerLog,
  workerLogFilePath,
} = await import("./logger.ts");

afterAll(() => {
  if (previousHome === undefined) delete process.env.LOOPHUB_HOME;
  else process.env.LOOPHUB_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

test("worker log sanitizer collapses control characters", () => {
  const message = sanitizeWorkerLogMessage(
    "line1\nfake\r\nescape\x1b[31mred\x07\x08end",
  );

  expect(message).toBe("line1 fake escape [31mred end");
  expect(
    [...message].some(
      (c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f,
    ),
  ).toBe(false);
});

test("worker logger writes sanitized messages to the console and log file", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});

  workerLog.info("ok\nline");
  workerLog.error("bad\x1b[31m");

  expect(out).toHaveBeenCalledWith("ok line");
  expect(err).toHaveBeenCalledWith("bad [31m");

  expect(dirname(workerLogFilePath())).toBe(join(home, "logs"));
  const lines = readFileSync(workerLogFilePath(), "utf8").trim().split("\n");
  expect(lines).toHaveLength(2);
  expect(lines[0]).toMatch(/^\[.+Z\] INFO ok line$/);
  expect(lines[1]).toMatch(/^\[.+Z\] ERROR bad \[31m$/);

  out.mockRestore();
  err.mockRestore();
});

test("worker errors retain their stack in a single persisted log line", () => {
  const err = vi.spyOn(console, "error").mockImplementation(() => {});
  const error = new Error("cache failed");
  error.stack = "Error: cache failed\n    at projection (worker.ts:1:2)";

  workerLog.error(`projection failed: ${workerErrorDetail(error)}`);

  expect(err).toHaveBeenCalledWith(
    "projection failed: Error: cache failed     at projection (worker.ts:1:2)",
  );
  const lines = readFileSync(workerLogFilePath(), "utf8").trim().split("\n");
  expect(lines.at(-1)).toMatch(
    /ERROR projection failed: Error: cache failed {5}at projection \(worker\.ts:1:2\)$/,
  );
  err.mockRestore();
});
