import { describe, expect, it } from "vitest";
import {
  countDiffFeedbackMessagesByFile,
  selectDiffFeedbackThreads,
  selectUnansweredDiffFeedbackThreads,
} from "./diff-feedback-selection.ts";
import type { DiffFeedbackThreadWire } from "./serialize.ts";

function thread(
  id: number,
  path: string,
  freshness: DiffFeedbackThreadWire["freshness"] = "outdated",
): DiffFeedbackThreadWire {
  return {
    id,
    pr_number: 1,
    anchor: {
      base_sha: "a".repeat(40),
      head_sha: "b".repeat(40),
      path,
      original_path: null,
      side: "RIGHT",
      start_line: 1,
      end_line: 1,
    },
    resolved_anchor: null,
    freshness,
    outdated_reason: freshness === "outdated" ? "modified" : null,
    placement: freshness === "current" ? "inline" : "historical",
    original_context: null,
    archived_at: null,
    created_by: "reviewer",
    created_by_type: "agent",
    created_at: "2026-07-28T00:00:00Z",
    messages: [],
  };
}

describe("selectDiffFeedbackThreads", () => {
  const files = [
    {
      filename: "old.ts => new.ts",
      headFilename: "new.ts",
      previousFilename: "old.ts",
    },
  ];

  it("associates a historical old-path thread with its renamed file", () => {
    expect(
      selectDiffFeedbackThreads([thread(1, "old.ts")], files, {
        path: "new.ts",
      }).map(({ id }) => id),
    ).toEqual([1]);
  });

  it("returns only historical threads unrelated to the current diff as orphaned", () => {
    expect(
      selectDiffFeedbackThreads(
        [
          thread(1, "old.ts"),
          thread(2, "deleted.ts", "unavailable"),
          thread(3, "elsewhere.ts", "current"),
        ],
        files,
        { orphaned: true },
      ).map(({ id }) => id),
    ).toEqual([2]);
  });
});

describe("selectUnansweredDiffFeedbackThreads", () => {
  function withMessages(id: number, authors: string[]): DiffFeedbackThreadWire {
    const value = thread(id, "a.ts");
    value.messages = authors.map((author, index) => ({
      id: id * 10 + index,
      thread_id: id,
      author,
      author_type: "agent",
      body: "Comment",
      created_at: `2026-07-28T00:0${index}:00Z`,
      reactions: [],
    }));
    return value;
  }

  it("keeps the threads whose newest message no responder wrote", () => {
    expect(
      selectUnansweredDiffFeedbackThreads(
        [
          withMessages(1, ["me"]),
          withMessages(2, ["me", "executor #1"]),
          withMessages(3, ["me", "executor #1", "me"]),
        ],
        new Set(["executor #1", "executor #2"]),
      ).map(({ id }) => id),
    ).toEqual([1, 3]);
  });

  it("treats a thread answered by an earlier turn's child as answered", () => {
    expect(
      selectUnansweredDiffFeedbackThreads(
        [withMessages(1, ["me", "executor #1"])],
        new Set(["executor #1", "executor #2"]),
      ),
    ).toEqual([]);
  });

  it("does not return an archived conversation as pending", () => {
    const archived = withMessages(1, ["me"]);
    archived.archived_at = "2026-07-28T01:00:00Z";
    expect(
      selectUnansweredDiffFeedbackThreads([archived], new Set(["executor #1"])),
    ).toEqual([]);
  });
});

describe("countDiffFeedbackMessagesByFile", () => {
  it("counts messages across renamed paths and original anchor paths", () => {
    const renamed = {
      filename: "old.ts => new.ts",
      headFilename: "new.ts",
      previousFilename: "old.ts",
    };
    const oldPathThread = thread(1, "old.ts");
    oldPathThread.messages = [
      {
        id: 1,
        thread_id: 1,
        author: "reviewer",
        author_type: "agent",
        body: "Comment",
        created_at: "2026-07-28T00:00:00Z",
        reactions: [],
      },
    ];
    const originalPathThread = thread(2, "generated.ts");
    originalPathThread.anchor.original_path = "new.ts";
    originalPathThread.messages = [
      {
        id: 2,
        thread_id: 2,
        author: "reviewer",
        author_type: "agent",
        body: "Comment",
        created_at: "2026-07-28T00:00:00Z",
        reactions: [],
      },
      {
        id: 3,
        thread_id: 2,
        author: "author",
        author_type: "agent",
        body: "Reply",
        created_at: "2026-07-28T00:01:00Z",
        reactions: [],
      },
    ];

    expect(
      countDiffFeedbackMessagesByFile(
        [oldPathThread, originalPathThread, thread(3, "other.ts")],
        [renamed, { filename: "untouched.ts" }],
      ),
    ).toEqual({
      "old.ts => new.ts": 3,
      "untouched.ts": 0,
    });
  });
});
