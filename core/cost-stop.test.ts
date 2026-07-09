import { describe, expect, test } from "vitest";
import { decideCostStop } from "./cost-stop.ts";

describe("decideCostStop", () => {
  const base = {
    limitUsd: 10,
    alreadyStopped: false,
    hasDevSession: true,
  };

  test("stops when top-level cost exceeds the limit", () => {
    expect(decideCostStop({ ...base, costUsd: 10.01 })).toEqual({
      action: "stop",
      costUsd: 10.01,
    });
  });

  test("does not stop at or below the limit (settled, not retryable)", () => {
    for (const costUsd of [0, 5, 10]) {
      expect(decideCostStop({ ...base, costUsd })).toEqual({
        action: "skip",
        retryable: false,
        reason: "under_limit",
      });
    }
  });

  test("already-stopped is a settled no-op even when over the limit (idempotency)", () => {
    expect(
      decideCostStop({ ...base, costUsd: 999, alreadyStopped: true }),
    ).toEqual({ action: "skip", retryable: false, reason: "already_stopped" });
  });

  test("unknown cost is retryable, never a stop (ambiguous → don't stop)", () => {
    expect(decideCostStop({ ...base, costUsd: null })).toEqual({
      action: "skip",
      retryable: true,
      reason: "unknown_cost",
    });
  });

  test("no dev session is retryable, never a stop (ambiguous → don't stop)", () => {
    expect(
      decideCostStop({ ...base, costUsd: 999, hasDevSession: false }),
    ).toEqual({ action: "skip", retryable: true, reason: "no_session" });
  });
});
