import { expect, test } from "vitest";
import {
  PR_TEST_MAP_PENDING_TTL_MS,
  prTestMapPendingUntil,
} from "./pr-test-map-pending.ts";

test("a start timestamp expires one TTL later", () => {
  expect(prTestMapPendingUntil("2026-08-19T00:00:00Z")).toBe(
    Date.parse("2026-08-19T00:00:00Z") + PR_TEST_MAP_PENDING_TTL_MS,
  );
});

test("no start timestamp means nothing is pending", () => {
  expect(prTestMapPendingUntil(null)).toBeNull();
  expect(prTestMapPendingUntil(undefined)).toBeNull();
});

test("an unparseable timestamp means nothing is pending", () => {
  expect(prTestMapPendingUntil("not a timestamp")).toBeNull();
});
