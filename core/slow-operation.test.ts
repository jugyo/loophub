import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureSlowOperationLogging,
  measureSlowOperation,
  measureSlowOperationAsync,
} from "./slow-operation.ts";

afterEach(() => {
  configureSlowOperationLogging();
  vi.restoreAllMocks();
});

describe("slow-operation logging", () => {
  it("does not measure or log when diagnostics are disabled", () => {
    const clock = vi.spyOn(performance, "now");
    const describeOperation = vi.fn(() => 'sql="SELECT 1"');
    const run = vi.fn(() => 42);

    expect(measureSlowOperation("sql", describeOperation, run)).toBe(42);
    expect(run).toHaveBeenCalledOnce();
    expect(clock).not.toHaveBeenCalled();
    expect(describeOperation).not.toHaveBeenCalled();
  });

  it("logs synchronous operations only when they exceed one second", () => {
    const log = vi.fn();
    configureSlowOperationLogging(log);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(1010)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(1020.1);

    measureSlowOperation(
      "sql",
      () => 'sql="SELECT fast"',
      () => undefined,
    );
    measureSlowOperation(
      "sql",
      () => 'sql="SELECT slow"',
      () => undefined,
    );

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(
      '[slow-operation] kind=sql duration_ms=1000.1 sql="SELECT slow"',
    );
  });

  it("measures an asynchronous operation until its promise settles", async () => {
    const log = vi.fn();
    configureSlowOperationLogging(log);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(1101);

    await measureSlowOperationAsync(
      "git",
      () => 'command=["git","status"]',
      async () => Promise.resolve(),
    );

    expect(log).toHaveBeenCalledWith(
      '[slow-operation] kind=git duration_ms=1001.0 command=["git","status"]',
    );
  });
});
