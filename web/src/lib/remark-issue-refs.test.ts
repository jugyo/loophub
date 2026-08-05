import { describe, expect, it } from "vitest";
import {
  type IssueRefKind,
  issueRefKey,
  issueRefTargets,
  remarkIssueRefs,
} from "./remark-issue-refs";

// The plugin operates on mdast, so these tests build the small trees react-markdown
// would hand it (a paragraph of text) rather than pulling in a Markdown parser. The
// end-to-end path — real parsing plus the resolved kinds — is covered by
// ../components/markdown.test.tsx.
interface Node {
  type: string;
  value?: string;
  url?: string;
  children?: Node[];
}

function paragraph(value: string): Node {
  return {
    type: "root",
    children: [{ type: "paragraph", children: [{ type: "text", value }] }],
  };
}

/** Resolved kinds keyed the way <Markdown> keys them, for the rendering repo `me/proj`. */
function here(entries: [number, IssueRefKind][]): Map<string, IssueRefKind> {
  return new Map(
    entries.map(([number, kind]) => [issueRefKey("me/proj", number), kind]),
  );
}

function hrefs(
  value: string,
  kinds?: ReadonlyMap<string, IssueRefKind>,
): (string | undefined)[] {
  const tree = paragraph(value);
  remarkIssueRefs({ owner: "me", repo: "proj", kinds })(tree);
  return (tree.children?.[0].children ?? [])
    .filter((node) => node.type === "link")
    .map((node) => node.url);
}

describe("issueRefTargets", () => {
  it("collects referenced numbers for the rendering repo, deduplicated and sorted", () => {
    expect(issueRefTargets("see #12, #3 and #12 again", "me/proj")).toEqual([
      { repo: "me/proj", numbers: [3, 12] },
    ]);
  });

  it("groups cross-repo references under the repo they name", () => {
    expect(
      issueRefTargets("#1 and other/lib#9 and other/lib#2", "me/proj"),
    ).toEqual([
      { repo: "me/proj", numbers: [1] },
      { repo: "other/lib", numbers: [2, 9] },
    ]);
  });

  it("sorts the groups by repo so the same body always yields the same key", () => {
    expect(
      issueRefTargets("b/two#1 and a/one#1", "me/proj").map((t) => t.repo),
    ).toEqual(["a/one", "b/two"]);
  });

  it("ignores hashes that are not refs", () => {
    expect(issueRefTargets("#fff &#39; abc#1 path#2", "me/proj")).toEqual([]);
  });

  it("ignores a repo-shaped path inside a URL", () => {
    expect(
      issueRefTargets("https://github.com/other/lib#12 here", "me/proj"),
    ).toEqual([]);
  });

  it("returns an empty list for a body with no refs", () => {
    expect(issueRefTargets("no references here", "me/proj")).toEqual([]);
  });
});

describe("remarkIssueRefs", () => {
  it("links a ref to the canonical issue route when the number is an issue", () => {
    expect(hrefs("see #7", here([[7, "issue"]]))).toEqual([
      "/r/me/proj/issues/7",
    ]);
  });

  it("links a ref to the canonical pull route when the number is a pull", () => {
    expect(hrefs("see #7", here([[7, "pull"]]))).toEqual([
      "/r/me/proj/pulls/7",
    ]);
  });

  it("links issue and pull refs in one body to their own routes", () => {
    const kinds = here([
      [7, "issue"],
      [8, "pull"],
    ]);
    expect(hrefs("#7 then #8", kinds)).toEqual([
      "/r/me/proj/issues/7",
      "/r/me/proj/pulls/8",
    ]);
  });

  it("does not link a number with no known kind", () => {
    expect(hrefs("see #7", here([[8, "issue"]]))).toEqual([]);
  });

  it("does not link anything while kinds are unresolved", () => {
    expect(hrefs("see #7")).toEqual([]);
  });

  it("leaves an unlinkable ref inside the surrounding text span", () => {
    const tree = paragraph("see #7 and #8 now");
    remarkIssueRefs({
      owner: "me",
      repo: "proj",
      kinds: here([[8, "pull"]]),
    })(tree);
    const parts = tree.children?.[0].children ?? [];
    expect(parts.map((node) => node.type)).toEqual(["text", "link", "text"]);
    expect(parts[0].value).toBe("see #7 and ");
    expect(parts[1].children?.[0].value).toBe("#8");
    expect(parts[2].value).toBe(" now");
  });

  it("leaves the node untouched when no ref can be linked", () => {
    const tree = paragraph("see #7 now");
    remarkIssueRefs({ owner: "me", repo: "proj" })(tree);
    const parts = tree.children?.[0].children ?? [];
    expect(parts).toHaveLength(1);
    expect(parts[0].value).toBe("see #7 now");
  });

  it("percent-encodes owner and repo in the generated href", () => {
    const tree = paragraph("see #7");
    remarkIssueRefs({
      owner: "a b",
      repo: "c/d",
      kinds: new Map([[issueRefKey("a b/c/d", 7), "pull" as const]]),
    })(tree);
    expect(tree.children?.[0].children?.[1].url).toBe("/r/a%20b/c%2Fd/pulls/7");
  });

  it("keeps the surrounding text and the ref label", () => {
    const tree = paragraph("see #7 now");
    remarkIssueRefs({
      owner: "me",
      repo: "proj",
      kinds: here([[7, "pull"]]),
    })(tree);
    const parts = tree.children?.[0].children ?? [];
    expect(parts.map((node) => node.type)).toEqual(["text", "link", "text"]);
    expect(parts[0].value).toBe("see ");
    expect(parts[1].children?.[0].value).toBe("#7");
    expect(parts[2].value).toBe(" now");
  });
});

describe("remarkIssueRefs cross-repo", () => {
  it("links owner/repo#n to that repo's canonical route", () => {
    const kinds = new Map([
      [issueRefKey("other/lib", 7), "issue" as const],
      [issueRefKey("other/lib", 8), "pull" as const],
    ]);
    expect(hrefs("see other/lib#7 and other/lib#8", kinds)).toEqual([
      "/r/other/lib/issues/7",
      "/r/other/lib/pulls/8",
    ]);
  });

  it("keeps the full reference as the link label", () => {
    const tree = paragraph("see other/lib#7 now");
    remarkIssueRefs({
      owner: "me",
      repo: "proj",
      kinds: new Map([[issueRefKey("other/lib", 7), "issue" as const]]),
    })(tree);
    const parts = tree.children?.[0].children ?? [];
    expect(parts.map((node) => node.type)).toEqual(["text", "link", "text"]);
    expect(parts[0].value).toBe("see ");
    expect(parts[1].children?.[0].value).toBe("other/lib#7");
    expect(parts[2].value).toBe(" now");
  });

  it("tells the same number in two repos apart", () => {
    const kinds = new Map([
      [issueRefKey("me/proj", 7), "issue" as const],
      [issueRefKey("other/lib", 7), "pull" as const],
    ]);
    expect(hrefs("#7 and other/lib#7", kinds)).toEqual([
      "/r/me/proj/issues/7",
      "/r/other/lib/pulls/7",
    ]);
  });

  it("does not link a repo that resolved to nothing", () => {
    expect(
      hrefs(
        "see other/lib#7",
        new Map([[issueRefKey("me/proj", 7), "issue" as const]]),
      ),
    ).toEqual([]);
  });

  it("does not link a repo-shaped path inside a URL", () => {
    const kinds = new Map([[issueRefKey("other/lib", 7), "issue" as const]]);
    expect(hrefs("https://github.com/other/lib#7", kinds)).toEqual([]);
  });

  it("accepts dots and dashes in the referenced owner and repo", () => {
    const kinds = new Map([[issueRefKey("o-x/r.y", 7), "pull" as const]]);
    expect(hrefs("see o-x/r.y#7", kinds)).toEqual(["/r/o-x/r.y/pulls/7"]);
  });

  it("links a reference that follows a dash", () => {
    const kinds = new Map([[issueRefKey("other/lib", 7), "issue" as const]]);
    expect(hrefs("-other/lib#7", kinds)).toEqual(["/r/other/lib/issues/7"]);
  });
});
