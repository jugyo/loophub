import { afterEach, describe, expect, it, vi } from "vitest";
import { runGitSync } from "./git.ts";
import {
  configureSlowOperationLogging,
  SLOW_GIT_OPERATION_MS,
} from "./slow-operation.ts";

afterEach(() => {
  configureSlowOperationLogging();
  vi.restoreAllMocks();
});

describe("Git diagnostic logging", () => {
  it("logs only a safe operation classification after the threshold", () => {
    const log = vi.fn();
    configureSlowOperationLogging(log);
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(SLOW_GIT_OPERATION_MS + 1);

    runGitSync(["log", "--", "branch"]);

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(
        "git operation=log repo=unknown duration_ms=101 exit_status=",
      ),
    );
    expect(log.mock.calls[0][0]).not.toContain("branch");
  });
});
