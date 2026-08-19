import { expect, test } from "vitest";
import {
  PR_CHANGE_MAP_PENDING_TTL_MS,
  prChangeMapPendingUntil,
} from "./pr-change-map-pending.ts";

test("a start timestamp expires one TTL later", () => {
  expect(prChangeMapPendingUntil("2026-08-05T00:00:00Z")).toBe(
    Date.parse("2026-08-05T00:00:00Z") + PR_CHANGE_MAP_PENDING_TTL_MS,
  );
});

test("no start timestamp means nothing is pending", () => {
  expect(prChangeMapPendingUntil(null)).toBeNull();
  expect(prChangeMapPendingUntil(undefined)).toBeNull();
});

test("an unparseable timestamp means nothing is pending", () => {
  expect(prChangeMapPendingUntil("not a timestamp")).toBeNull();
});
