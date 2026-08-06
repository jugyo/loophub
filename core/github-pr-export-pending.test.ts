import { describe, expect, test } from "vitest";
import {
  GITHUB_PR_EXPORT_PENDING_TTL_MS,
  githubPrExportPendingUntil,
} from "./github-pr-export-pending.ts";

describe("githubPrExportPendingUntil", () => {
  test("expires one TTL after the export started", () => {
    const started = Date.parse("2026-08-05T00:00:00Z");
    expect(githubPrExportPendingUntil("2026-08-05T00:00:00Z")).toBe(
      started + GITHUB_PR_EXPORT_PENDING_TTL_MS,
    );
  });

  test("is null when the export never started", () => {
    expect(githubPrExportPendingUntil(null)).toBeNull();
    expect(githubPrExportPendingUntil(undefined)).toBeNull();
  });

  // An unparseable timestamp must read as "no export running" rather than as one that started at
  // the epoch (already expired) or NaN (comparisons silently false) — the button stays clickable.
  test("is null for an unparseable timestamp", () => {
    expect(githubPrExportPendingUntil("not a timestamp")).toBeNull();
  });
});
