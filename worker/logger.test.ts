import { expect, test, vi } from "vitest";
import { sanitizeWorkerLogMessage, workerLog } from "./logger.ts";

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

test("worker logger routes info to stdout and errors to stderr after sanitizing", () => {
  const out = vi.spyOn(console, "log").mockImplementation(() => {});
  const err = vi.spyOn(console, "error").mockImplementation(() => {});

  workerLog.info("ok\nline");
  workerLog.error("bad\x1b[31m");

  expect(out).toHaveBeenCalledWith("ok line");
  expect(err).toHaveBeenCalledWith("bad [31m");

  out.mockRestore();
  err.mockRestore();
});
