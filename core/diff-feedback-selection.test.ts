import { describe, expect, it } from "vitest";
import {
  countDiffFeedbackMessagesByFile,
  selectDiffFeedbackThreads,
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
    freshness,
    created_by: "reviewer",
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
        body: "Comment",
        created_at: "2026-07-28T00:00:00Z",
      },
    ];
    const originalPathThread = thread(2, "generated.ts");
    originalPathThread.anchor.original_path = "new.ts";
    originalPathThread.messages = [
      {
        id: 2,
        thread_id: 2,
        author: "reviewer",
        body: "Comment",
        created_at: "2026-07-28T00:00:00Z",
      },
      {
        id: 3,
        thread_id: 2,
        author: "author",
        body: "Reply",
        created_at: "2026-07-28T00:01:00Z",
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
