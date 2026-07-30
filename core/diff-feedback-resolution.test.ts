import { describe, expect, test } from "vitest";
import {
  lcsLineMap,
  resolveDiffFeedbackRange,
} from "./diff-feedback-resolution.ts";

describe("lcsLineMap", () => {
  test("maps unchanged lines around insertions and deletions", () => {
    expect([...lcsLineMap(["a", "b", "c", "d"], ["x", "a", "c", "d"])]).toEqual(
      [
        [0, 1],
        [2, 2],
        [3, 3],
      ],
    );
  });
});

describe("resolveDiffFeedbackRange", () => {
  test("moves an unchanged range when lines are inserted above it", () => {
    expect(
      resolveDiffFeedbackRange(
        ["one", "target", "three"],
        ["zero", "one", "target", "three"],
        2,
        2,
      ),
    ).toMatchObject({ status: "current", startLine: 3, endLine: 3 });
  });

  test("finds an exact range moved within the same file", () => {
    expect(
      resolveDiffFeedbackRange(
        ["one", "target", "three", "four"],
        ["one", "three", "four", "target"],
        2,
        2,
      ),
    ).toEqual({
      status: "current",
      startLine: 4,
      endLine: 4,
      match: "exact",
    });
  });

  test("rejects exact candidates equally distant from the LCS prediction", () => {
    expect(
      resolveDiffFeedbackRange(
        ["a", "b", "c", "target", "d", "e", "f"],
        ["target", "a", "b", "c", "d", "e", "f", "target"],
        4,
        4,
      ),
    ).toEqual({ status: "outdated", reason: "ambiguous" });
  });

  test("rejects adjacent duplicates even when LCS maps one candidate", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "target", "after"],
        ["before", "target", "target", "after"],
        2,
        2,
      ),
    ).toEqual({ status: "outdated", reason: "ambiguous" });
  });

  test("rejects non-equidistant duplicates when the LCS prediction has a tied alignment", () => {
    expect(
      resolveDiffFeedbackRange(
        ["a", "target", "b", "c", "d"],
        ["target", "a", "b", "c", "d", "target"],
        2,
        2,
      ),
    ).toEqual({ status: "outdated", reason: "ambiguous" });
  });

  test("keeps a duplicate with a unique surrounding LCS alignment", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "target", "after", "x", "y"],
        ["before", "target", "after", "x", "y", "target"],
        2,
        2,
      ),
    ).toEqual({
      status: "current",
      startLine: 2,
      endLine: 2,
      match: "lcs",
    });
  });

  test("accepts a small edit only at the predicted range", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "const answer = 41;", "after"],
        ["before", "const answer = 42;", "after"],
        2,
        2,
      ),
    ).toEqual({
      status: "current",
      startLine: 2,
      endLine: 2,
      match: "fuzzy",
    });
    expect(
      resolveDiffFeedbackRange(
        ["before", "const answer = 41;", "after"],
        ["before", "completely rewritten", "after"],
        2,
        2,
      ),
    ).toEqual({ status: "outdated", reason: "modified" });
  });

  test("uses the documented 0.8 similarity boundary", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "abcdefghij", "after"],
        ["before", "abXXefghij", "after"],
        2,
        2,
      ),
    ).toMatchObject({ status: "current", match: "fuzzy" });
    expect(
      resolveDiffFeedbackRange(
        ["before", "abcdefghij", "after"],
        ["before", "abXXXfghij", "after"],
        2,
        2,
      ),
    ).toEqual({ status: "outdated", reason: "modified" });
  });

  test("rejects multiple fuzzy candidates at LCS-predicted ranges", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "abcdefghij", "after"],
        ["before", "abXXefghij", "inserted", "abYYefghij", "after"],
        2,
        2,
      ),
    ).toEqual({ status: "outdated", reason: "ambiguous" });
  });

  test("accepts the only fuzzy candidate that meets the threshold", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "abcdefghij", "after"],
        ["before", "abXXefghij", "inserted", "completely rewritten", "after"],
        2,
        2,
      ),
    ).toEqual({
      status: "current",
      startLine: 2,
      endLine: 2,
      match: "fuzzy",
    });
  });

  test("classifies a range removed between mapped neighbours as deleted", () => {
    expect(
      resolveDiffFeedbackRange(
        ["before", "remove this line", "after"],
        ["before", "after"],
        2,
        2,
      ),
    ).toEqual({ status: "outdated", reason: "deleted" });
  });
});
