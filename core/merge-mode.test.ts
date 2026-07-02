import { describe, expect, test } from "vitest";
import {
  effectiveMergeMode,
  isGithubRemoteUrl,
  normalizeMergeMode,
  parseGithubPullNumber,
} from "./merge-mode.ts";

describe("normalizeMergeMode", () => {
  test("passes through the two valid modes", () => {
    expect(normalizeMergeMode("merge")).toBe("merge");
    expect(normalizeMergeMode("github_pr")).toBe("github_pr");
  });
  test("collapses unset / unknown to null", () => {
    expect(normalizeMergeMode(null)).toBeNull();
    expect(normalizeMergeMode(undefined)).toBeNull();
    expect(normalizeMergeMode("")).toBeNull();
    expect(normalizeMergeMode("github")).toBeNull();
  });
});

describe("isGithubRemoteUrl", () => {
  test("recognizes https / scp / ssh GitHub URLs (with and without .git)", () => {
    expect(isGithubRemoteUrl("https://github.com/o/r.git")).toBe(true);
    expect(isGithubRemoteUrl("https://github.com/o/r")).toBe(true);
    expect(isGithubRemoteUrl("git@github.com:o/r.git")).toBe(true);
    expect(isGithubRemoteUrl("ssh://git@github.com/o/r.git")).toBe(true);
    expect(isGithubRemoteUrl("https://www.github.com/o/r")).toBe(true);
    expect(isGithubRemoteUrl("HTTPS://GitHub.com/O/R")).toBe(true);
  });
  test("rejects non-GitHub and empty URLs", () => {
    expect(isGithubRemoteUrl(null)).toBe(false);
    expect(isGithubRemoteUrl("")).toBe(false);
    expect(isGithubRemoteUrl("https://gitlab.com/o/r.git")).toBe(false);
    expect(isGithubRemoteUrl("git@bitbucket.org:o/r.git")).toBe(false);
    // GitHub Enterprise hosts are not the public github.com — not matched.
    expect(isGithubRemoteUrl("https://github.example.com/o/r")).toBe(false);
    // A host that merely contains the substring must not match.
    expect(isGithubRemoteUrl("https://notgithub.com/o/r")).toBe(false);
    expect(isGithubRemoteUrl("https://github.com.evil.com/o/r")).toBe(false);
  });
});

describe("parseGithubPullNumber", () => {
  test("extracts the number from a GitHub PR URL (#487)", () => {
    expect(parseGithubPullNumber("https://github.com/o/r/pull/42")).toBe(42);
    expect(parseGithubPullNumber("https://github.com/o/r/pull/42/files")).toBe(
      42,
    );
  });
  test("returns null when there is no /pull/<number> segment", () => {
    expect(parseGithubPullNumber("https://github.com/o/r")).toBeNull();
    expect(parseGithubPullNumber(null)).toBeNull();
    expect(parseGithubPullNumber("")).toBeNull();
  });
});

describe("effectiveMergeMode", () => {
  test("pinned setting wins over the remote default", () => {
    expect(effectiveMergeMode("merge", true)).toBe("merge");
    expect(effectiveMergeMode("github_pr", false)).toBe("github_pr");
  });
  test("unset falls back to remote-based default", () => {
    expect(effectiveMergeMode(null, true)).toBe("github_pr");
    expect(effectiveMergeMode(null, false)).toBe("merge");
    expect(effectiveMergeMode("bogus", true)).toBe("github_pr");
  });
});
