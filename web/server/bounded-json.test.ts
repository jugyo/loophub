import { expect, test } from "vitest";
import { stringifyJsonWithinLimit } from "./bounded-json.ts";

test("serializes JSON with native compact semantics within the byte limit", () => {
  const value = {
    text: "日本語\ntext",
    values: [1, undefined, Number.NaN, true],
    omitted: undefined,
    date: new Date("2026-07-11T00:00:00.000Z"),
  };
  const expected = JSON.stringify(value);

  expect(stringifyJsonWithinLimit(value, Buffer.byteLength(expected))).toBe(
    expected,
  );
});

test("returns null instead of retaining JSON beyond the byte limit", () => {
  const value = { result: "x".repeat(1024) };
  const expected = JSON.stringify(value);

  expect(
    stringifyJsonWithinLimit(value, Buffer.byteLength(expected) - 1),
  ).toBeNull();
});

test("rejects a single oversized string before serializing the full value", () => {
  expect(stringifyJsonWithinLimit("x".repeat(1024), 100)).toBeNull();
});

test("matches JSON.stringify for omitted roots and circular values", () => {
  expect(stringifyJsonWithinLimit(undefined, 100)).toBeUndefined();
  expect(stringifyJsonWithinLimit(() => {}, 100)).toBeUndefined();
  expect(stringifyJsonWithinLimit(Symbol("root"), 100)).toBeUndefined();
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(() => stringifyJsonWithinLimit(circular, 100)).toThrow(TypeError);
});
