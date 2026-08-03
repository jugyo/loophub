import { describe, expect, test } from "vitest";
import {
  WORKER_HEARTBEAT_STALE_AFTER_MS,
  WORKFLOW_WORKER_PROTOCOL_VERSION,
  workerCompatibility,
} from "./worker-protocol.ts";

const NOW = Date.parse("2026-08-02T00:00:10Z");
const freshRuntime = {
  protocol_version: WORKFLOW_WORKER_PROTOCOL_VERSION,
  started_at: "2026-08-02T00:00:00Z",
  heartbeat_at: "2026-08-02T00:00:09Z",
};

describe("workerCompatibility", () => {
  test("reports a fresh current-protocol worker as compatible", () => {
    expect(workerCompatibility(freshRuntime, NOW)).toMatchObject({
      status: "compatible",
      stale_at: "2026-08-02T00:01:09.000Z",
    });
  });

  test("tolerates a delayed heartbeat beyond the previous stale window", () => {
    expect(
      workerCompatibility(freshRuntime, Date.parse("2026-08-02T00:00:26Z"))
        .status,
    ).toBe("compatible");
  });

  test.each([
    ["older", WORKFLOW_WORKER_PROTOCOL_VERSION - 1],
    ["newer", WORKFLOW_WORKER_PROTOCOL_VERSION + 1],
  ])("reports a fresh %s protocol as incompatible", (_label, version) => {
    expect(
      workerCompatibility({ ...freshRuntime, protocol_version: version }, NOW),
    ).toMatchObject({
      status: "incompatible",
      observed_protocol_version: version,
    });
  });

  test("reports an absent record as missing", () => {
    expect(workerCompatibility(null, NOW)).toMatchObject({
      status: "missing",
      observed_protocol_version: null,
      stale_at: null,
    });
  });

  test("reports an expired heartbeat as stale before considering its protocol", () => {
    const heartbeat = new Date(
      NOW - WORKER_HEARTBEAT_STALE_AFTER_MS - 1,
    ).toISOString();
    expect(
      workerCompatibility(
        { ...freshRuntime, protocol_version: 999, heartbeat_at: heartbeat },
        NOW,
      ),
    ).toMatchObject({ status: "stale", observed_protocol_version: 999 });
  });
});
