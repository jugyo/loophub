import { describe, expect, it } from "vitest";
import {
  type IssueRefKind,
  issueRefNumbers,
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

function hrefs(
  value: string,
  kinds?: ReadonlyMap<number, IssueRefKind>,
): (string | undefined)[] {
  const tree = paragraph(value);
  remarkIssueRefs({ owner: "me", repo: "proj", kinds })(tree);
  return (tree.children?.[0].children ?? [])
    .filter((node) => node.type === "link")
    .map((node) => node.url);
}

describe("issueRefNumbers", () => {
  it("collects referenced numbers, deduplicated and sorted", () => {
    expect(issueRefNumbers("see #12, #3 and #12 again")).toEqual([3, 12]);
  });

  it("ignores hashes that are not refs", () => {
    expect(issueRefNumbers("#fff &#39; abc#1 path#2")).toEqual([]);
  });

  it("returns an empty list for a body with no refs", () => {
    expect(issueRefNumbers("no references here")).toEqual([]);
  });
});

describe("remarkIssueRefs", () => {
  it("links a ref to the canonical issue route when the number is an issue", () => {
    expect(hrefs("see #7", new Map([[7, "issue"]]))).toEqual([
      "/r/me/proj/issues/7",
    ]);
  });

  it("links a ref to the canonical pull route when the number is a pull", () => {
    expect(hrefs("see #7", new Map([[7, "pull"]]))).toEqual([
      "/r/me/proj/pulls/7",
    ]);
  });

  it("links issue and pull refs in one body to their own routes", () => {
    const kinds = new Map<number, IssueRefKind>([
      [7, "issue"],
      [8, "pull"],
    ]);
    expect(hrefs("#7 then #8", kinds)).toEqual([
      "/r/me/proj/issues/7",
      "/r/me/proj/pulls/8",
    ]);
  });

  it("does not link a number with no known kind", () => {
    expect(hrefs("see #7", new Map([[8, "issue"]]))).toEqual([]);
  });

  it("does not link anything while kinds are unresolved", () => {
    expect(hrefs("see #7")).toEqual([]);
  });

  it("leaves an unlinkable ref inside the surrounding text span", () => {
    const tree = paragraph("see #7 and #8 now");
    remarkIssueRefs({
      owner: "me",
      repo: "proj",
      kinds: new Map<number, IssueRefKind>([[8, "pull"]]),
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
      kinds: new Map([[7, "pull"]]),
    })(tree);
    expect(tree.children?.[0].children?.[1].url).toBe("/r/a%20b/c%2Fd/pulls/7");
  });

  it("keeps the surrounding text and the ref label", () => {
    const tree = paragraph("see #7 now");
    remarkIssueRefs({
      owner: "me",
      repo: "proj",
      kinds: new Map([[7, "pull"]]),
    })(tree);
    const parts = tree.children?.[0].children ?? [];
    expect(parts.map((node) => node.type)).toEqual(["text", "link", "text"]);
    expect(parts[0].value).toBe("see ");
    expect(parts[1].children?.[0].value).toBe("#7");
    expect(parts[2].value).toBe(" now");
  });
});
