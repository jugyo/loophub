import { afterEach, describe, expect, it, vi } from "#loophub-test";
import type { PullFile, PullRequest, PullReview } from "@/api/types";
import {
  getPullRailSeen,
  pullRailFingerprints,
  pullRailViewChanged,
  setPullRailSeen,
} from "./pull-rail-seen";

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const file = {
  filename: "a.ts",
  status: "modified",
  additions: 1,
  deletions: 0,
  last_changed_sha: "c1",
} as PullFile;
const pull = {
  body: "evidence",
  commits: [{ sha: "c1" }],
} as unknown as PullRequest;
const review = { id: 7 } as PullReview;

describe("pullRailFingerprints", () => {
  const base = pullRailFingerprints(pull, [file], [review]);

  it("changes the Files fingerprint for a new version of a file", () => {
    const next = pullRailFingerprints(
      pull,
      [{ ...file, last_changed_sha: "c2" }],
      [review],
    );
    expect(next.files).not.toBe(base.files);
    expect(next.evidence).toBe(base.evidence);
  });

  it("changes the Evidence fingerprint with the body", () => {
    const next = pullRailFingerprints(
      { ...pull, body: "edited" },
      [file],
      [review],
    );
    expect(next.evidence).not.toBe(base.evidence);
  });

  it("leaves out views whose data has not loaded", () => {
    const next = pullRailFingerprints(pull, undefined, undefined);
    expect(next.files).toBeUndefined();
    expect(next.commits).toBeUndefined();
  });
});

describe("pullRailViewChanged", () => {
  it("flags Commits only when a commit or review was added", () => {
    expect(pullRailViewChanged("commits", "a\nb", "a\nb\nc")).toBe(true);
    expect(pullRailViewChanged("commits", "a\nb", "b")).toBe(false);
    expect(pullRailViewChanged("commits", "a", "")).toBe(false);
  });

  it("flags Files and Evidence on any difference", () => {
    expect(pullRailViewChanged("files", "x", "y")).toBe(true);
    expect(pullRailViewChanged("evidence", "x", "x")).toBe(false);
  });
});

describe("pull rail storage", () => {
  it("keeps a baseline per PR and view", () => {
    setPullRailSeen("me/proj/1", "files", "x");
    expect(getPullRailSeen("me/proj/1", "files")).toBe("x");
    expect(getPullRailSeen("me/proj/1", "evidence")).toBeNull();
    expect(getPullRailSeen("me/proj/2", "files")).toBeNull();
  });

  it("has no baseline when storage cannot be read or written", () => {
    const blocked = () => {
      throw new Error("blocked");
    };
    vi.stubGlobal("localStorage", { getItem: blocked, setItem: blocked });

    expect(() => setPullRailSeen("me/proj/1", "files", "x")).not.toThrow();
    expect(getPullRailSeen("me/proj/1", "files")).toBeNull();
  });
});
