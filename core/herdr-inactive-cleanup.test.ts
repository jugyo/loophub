import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
  herdrInactiveCleanupCandidate,
  parseHerdrInactiveCleanupCandidates,
} from "./herdr-inactive-cleanup.ts";

describe("herdrInactiveCleanupCandidate", () => {
  const nowMs = Date.parse("2026-07-03T12:00:00Z");

  test("selects inactive panes whose reported inactive age is at least ten minutes", () => {
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "inactive",
          inactive_seconds: 600,
          name: "dev #1",
          pane_id: "w1:p2",
        },
        nowMs,
      ),
    ).toEqual({
      inactiveMs: HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
      name: "dev #1",
      paneId: "w1:p2",
    });
  });

  test("does not select inactive panes below the ten-minute threshold", () => {
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "inactive",
          inactive_ms: HERDR_INACTIVE_CLEANUP_THRESHOLD_MS - 1,
          name: "dev #1",
          pane_id: "w1:p2",
        },
        nowMs,
      ),
    ).toBeNull();
  });

  test("does not select inactive panes when inactivity age is unavailable", () => {
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "inactive",
          name: "dev #1",
          pane_id: "w1:p2",
        },
        nowMs,
      ),
    ).toBeNull();
  });

  test("does not select active or working panes", () => {
    for (const status of ["active", "working", "blocked", "idle", "done"]) {
      expect(
        herdrInactiveCleanupCandidate(
          {
            agent_status: status,
            inactive_seconds: 3600,
            name: "dev #1",
            pane_id: "w1:p2",
          },
          nowMs,
        ),
      ).toBeNull();
    }
  });

  test("selects pull-closed done panes after threshold", () => {
    const root = "/tmp/lh-inactive-cleanup";
    const fullName = "me/repo";
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "done",
          status_since: "2026-07-03T11:49:30Z",
          foreground_cwd: join(root, fullName, "pr-123"),
          pane_id: "w1:p2",
        },
        nowMs,
        HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
        {
          worktreeRoot: root,
          fullName,
          isPullClosed: (pull) => pull === 123,
        },
      ),
    ).toEqual({
      inactiveMs: 630_000,
      name: "w1:p2",
      paneId: "w1:p2",
    });
  });

  test("does not select working panes even when pull is closed", () => {
    const root = "/tmp/lh-inactive-cleanup";
    const fullName = "me/repo";
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "working",
          status_since: "2026-07-03T11:49:30Z",
          foreground_cwd: join(root, fullName, "pr-123"),
          pane_id: "w1:p2",
        },
        nowMs,
        HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
        {
          worktreeRoot: root,
          fullName,
          isPullClosed: (pull) => pull === 123,
        },
      ),
    ).toBeNull();
  });

  test("selects no-PR idle panes after threshold", () => {
    const root = "/tmp/lh-inactive-cleanup";
    const fullName = "me/repo";
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "idle",
          status_since: "2026-07-03T11:49:30Z",
          foreground_cwd: join(root, fullName, "scratch"),
          pane_id: "w1:p2",
        },
        nowMs,
        HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
        { worktreeRoot: root, fullName },
      ),
    ).toEqual({
      inactiveMs: 630_000,
      name: "w1:p2",
      paneId: "w1:p2",
    });
  });

  test("does not select stale conditions without age", () => {
    const root = "/tmp/lh-inactive-cleanup";
    const fullName = "me/repo";
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "idle",
          foreground_cwd: join(root, fullName, "scratch"),
          pane_id: "w1:p2",
        },
        nowMs,
        HERDR_INACTIVE_CLEANUP_THRESHOLD_MS,
        { worktreeRoot: root, fullName },
      ),
    ).toBeNull();
  });

  test("does not select agents without a valid real pane id", () => {
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "inactive",
          inactive_seconds: 3600,
          name: "dev #1",
          pane_id: "--bad",
        },
        nowMs,
      ),
    ).toBeNull();
  });

  test("uses timestamp fields when Herdr reports when the pane became inactive", () => {
    expect(
      herdrInactiveCleanupCandidate(
        {
          agent_status: "inactive",
          inactive_since: "2026-07-03T11:49:30Z",
          name: "dev #1",
          pane_id: "w1:p2",
        },
        nowMs,
      )?.inactiveMs,
    ).toBe(630_000);
  });
});

describe("parseHerdrInactiveCleanupCandidates", () => {
  test("parses Herdr agent list output defensively", () => {
    const nowMs = Date.parse("2026-07-03T12:00:00Z");
    const stdout = JSON.stringify({
      result: {
        agents: [
          {
            agent_status: "inactive",
            inactive_seconds: 601,
            name: "old inactive",
            pane_id: "w1:p1",
          },
          {
            agent_status: "inactive",
            inactive_seconds: 10,
            name: "new inactive",
            pane_id: "w1:p2",
          },
          {
            agent_status: "working",
            inactive_seconds: 3600,
            name: "working",
            pane_id: "w1:p3",
          },
          {
            agent_status: "done",
            status_since: "2026-07-03T11:49:30Z",
            cwd: "/tmp/lh-cleanup/me/repo/pr-7",
            pane_id: "w1:p4",
          },
          null,
        ],
      },
    });

    expect(parseHerdrInactiveCleanupCandidates(stdout, nowMs)).toEqual([
      { inactiveMs: 601_000, name: "old inactive", paneId: "w1:p1" },
    ]);

    expect(
      parseHerdrInactiveCleanupCandidates(stdout, nowMs, {
        fullName: "me/repo",
        worktreeRoot: "/tmp/lh-cleanup",
        isPullClosed: (pull) => pull === 7,
      }),
    ).toEqual([{ inactiveMs: 630_000, name: "w1:p4", paneId: "w1:p4" }]);
  });

  test.each([
    "",
    "not json",
    "{}",
    '{"result": {}}',
  ])("degrades to [] for malformed output %#", (stdout) => {
    expect(parseHerdrInactiveCleanupCandidates(stdout)).toEqual([]);
  });
});
