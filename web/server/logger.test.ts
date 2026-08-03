import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Isolate LOOPHUB_HOME before importing the logger (its file path is resolved at import time).
const home = mkdtempSync(join(tmpdir(), "lh-web-log-"));
const previousHome = process.env.LOOPHUB_HOME;
process.env.LOOPHUB_HOME = home;

let L: typeof import("./logger.ts");
beforeAll(async () => {
  L = await import("./logger.ts");
});

afterAll(() => {
  if (previousHome === undefined) delete process.env.LOOPHUB_HOME;
  else process.env.LOOPHUB_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe("web logger", () => {
  it("auto-creates the logs dir and appends timestamped, leveled lines", () => {
    const out = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    L.log.info("hello");
    L.log.warn("careful");
    L.log.error("boom");

    // Console output is preserved: info -> stdout, warn/error -> stderr.
    expect(out).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(2);
    out.mockRestore();
    err.mockRestore();

    expect(dirname(L.logFilePath())).toBe(join(home, "logs"));
    const content = readFileSync(L.logFilePath(), "utf8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(3);
    // [ISO-timestamp] LEVEL message
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] INFO hello$/);
    expect(lines[1]).toMatch(/^\[.+\] WARN careful$/);
    expect(lines[2]).toMatch(/^\[.+\] ERROR boom$/);
  });

  it("collapses CR/LF in messages so a call cannot forge extra log lines", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    L.log.error("line1\nfake [2026-01-01T00:00:00.000Z] ERROR forged\r\nx");
    vi.restoreAllMocks();

    const lines = readFileSync(L.logFilePath(), "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    // The whole message stays on one physical line.
    expect(last).toBe(last.replace(/\n/g, ""));
    expect(last).toMatch(/^\[.+\] ERROR line1 fake .* forged x$/);
  });

  it("strips ESC and other C0 control characters (no terminal escape injection)", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    // ESC, BEL, backspace embedded in an externally-influenced message.
    L.log.error("a\x1b[31mred\x07\x08b");
    vi.restoreAllMocks();

    const lines = readFileSync(L.logFilePath(), "utf8").trim().split("\n");
    const last = lines[lines.length - 1];
    // No control characters survive in the persisted line.
    expect(
      [...last].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f),
    ).toBe(false);
    expect(last).toMatch(/^\[.+\] ERROR a \[31mred b$/);
  });
});
