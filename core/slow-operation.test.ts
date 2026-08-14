import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureSlowOperationLogging,
  logDiagnostic,
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
});
