import { describe, expect, it } from "vitest";
import type { PullFile, PullFileView } from "@/api/types";
import {
  pullFileViewState,
  pullFileViewsByPath,
  viewedPullFileCount,
  visiblePullFiles,
} from "@/lib/pull-file-views";

function file(filename: string, lastChangedSha?: string): PullFile {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "",
    ...(lastChangedSha ? { last_changed_sha: lastChangedSha } : {}),
  };
}

function view(path: string, sha: string | null): PullFileView {
  return { path, sha, viewed_at: "2026-08-20T00:00:00Z" };
}

describe("pullFileViewState", () => {
  it("reads a file with no record as unviewed", () => {
    expect(pullFileViewState(file("a.ts", "sha1"), new Map())).toBe("unviewed");
  });

  it("reads a record pinned to the file's newest commit as viewed", () => {
    const views = pullFileViewsByPath([view("a.ts", "sha1")]);
    expect(pullFileViewState(file("a.ts", "sha1"), views)).toBe("viewed");
  });

  it("reads a record pinned to an older commit as changed", () => {
    const views = pullFileViewsByPath([view("a.ts", "sha1")]);
    expect(pullFileViewState(file("a.ts", "sha2"), views)).toBe("changed");
  });

  it("matches a record with no sha against a file with no last-changed commit", () => {
    const views = pullFileViewsByPath([view("a.ts", null)]);
    expect(pullFileViewState(file("a.ts"), views)).toBe("viewed");
    expect(pullFileViewState(file("a.ts", "sha1"), views)).toBe("changed");
  });
});

describe("visiblePullFiles", () => {
  const files = [
    file("viewed.ts", "sha1"),
    file("changed.ts", "sha2"),
    file("fresh.ts", "sha3"),
  ];
  const views = pullFileViewsByPath([
    view("viewed.ts", "sha1"),
    view("changed.ts", "sha1"),
  ]);

  it("hides viewed files but keeps the ones that moved on since", () => {
    expect(
      visiblePullFiles(files, views, false).map((entry) => entry.filename),
    ).toEqual(["changed.ts", "fresh.ts"]);
  });

  it("keeps every file when viewed ones are shown", () => {
    expect(
      visiblePullFiles(files, views, true).map((entry) => entry.filename),
    ).toEqual(["viewed.ts", "changed.ts", "fresh.ts"]);
  });
});

describe("viewedPullFileCount", () => {
  const files = [
    file("viewed.ts", "sha1"),
    file("changed.ts", "sha2"),
    file("fresh.ts", "sha3"),
  ];

  it("counts only the marks that still stand", () => {
    const views = pullFileViewsByPath([
      view("viewed.ts", "sha1"),
      view("changed.ts", "sha1"),
    ]);
    expect(viewedPullFileCount(files, views)).toBe(1);
  });

  it("counts nothing when no file is marked", () => {
    expect(viewedPullFileCount(files, new Map())).toBe(0);
  });
});
