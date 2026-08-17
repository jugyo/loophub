import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureSlowOperationLogging,
  logDiagnostic,
  measureDiagnostic,
} from "./slow-operation.ts";

afterEach(() => {
  configureSlowOperationLogging();
  vi.restoreAllMocks();
});

describe("diagnostic logging", () => {
  it("builds a diagnostic line only while diagnostics are enabled", () => {
    const message = vi.fn(() => "[diagnostic] event=test");

    logDiagnostic(message);
    expect(message).not.toHaveBeenCalled();

    const log = vi.fn();
    configureSlowOperationLogging(log);
    logDiagnostic(message);

    expect(log).toHaveBeenCalledWith("[diagnostic] event=test");
  });

  it("measures a pageData phase only while diagnostics are enabled", async () => {
    const operation = vi.fn(async () => "result");
    const log = vi.fn();

    await expect(
      measureDiagnostic("issueList.serialization", operation),
    ).resolves.toBe("result");
    expect(log).not.toHaveBeenCalled();

    configureSlowOperationLogging(log);
    await expect(
      measureDiagnostic("issueList.serialization", operation),
    ).resolves.toBe("result");
    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^pageData phase=issueList\.serialization duration_ms=\d+$/,
      ),
    );
  });
});
