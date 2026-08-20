import { describe, expect, it } from "vitest";
import {
  buildFileTree,
  type FileTreeNode,
  visibleFileTreeRows,
} from "@/lib/file-tree";

function outline(nodes: FileTreeNode<string>[], depth = 0): string[] {
  return nodes.flatMap((node) =>
    node.kind === "file"
      ? [`${"  ".repeat(depth)}${node.name}`]
      : [
          `${"  ".repeat(depth)}${node.name}/`,
          ...outline(node.children, depth + 1),
        ],
  );
}

describe("buildFileTree", () => {
  it("groups paths by directory and keeps files at the root", () => {
    const tree = buildFileTree(
      ["web/src/a.ts", "web/src/b.ts", "README.md"],
      (path) => path,
    );

    expect(outline(tree)).toEqual([
      "web/src/",
      "  a.ts",
      "  b.ts",
      "README.md",
    ]);
  });

  it("collapses a chain of single-child directories into one node", () => {
    const tree = buildFileTree(["core/service/nested/a.ts"], (path) => path);

    expect(outline(tree)).toEqual(["core/service/nested/", "  a.ts"]);
    expect(tree[0].path).toBe("core/service/nested");
  });

  it("stops collapsing where a directory has more than one child", () => {
    const tree = buildFileTree(
      ["core/a/x.ts", "core/b/y.ts", "core/b/z/w.ts"],
      (path) => path,
    );

    expect(outline(tree)).toEqual([
      "core/",
      "  a/",
      "    x.ts",
      "  b/",
      "    y.ts",
      "    z/",
      "      w.ts",
    ]);
  });

  it("keeps input order for directories and files", () => {
    const tree = buildFileTree(
      ["web/b.ts", "core/a.ts", "web/a.ts"],
      (path) => path,
    );

    expect(outline(tree)).toEqual([
      "web/",
      "  b.ts",
      "  a.ts",
      "core/",
      "  a.ts",
    ]);
  });

  it("carries the entry and its full path on file nodes", () => {
    const entries = [{ name: "web/src/a.ts" }];
    const tree = buildFileTree(entries, (entry) => entry.name);
    const directory = tree[0];
    if (directory.kind !== "directory") throw new Error("expected directory");
    const file = directory.children[0];

    expect(file).toEqual({
      kind: "file",
      name: "a.ts",
      path: "web/src/a.ts",
      entry: entries[0],
    });
  });
});

describe("visibleFileTreeRows", () => {
  const tree = buildFileTree(
    ["web/a.ts", "web/nested/b.ts", "README.md"],
    (path) => path,
  );

  it("lists every node with its depth when nothing is collapsed", () => {
    expect(
      visibleFileTreeRows(tree, new Set()).map(({ node, depth }) => [
        node.name,
        depth,
      ]),
    ).toEqual([
      ["web", 0],
      ["a.ts", 1],
      ["nested", 1],
      ["b.ts", 2],
      ["README.md", 0],
    ]);
  });

  it("hides the children of a collapsed directory", () => {
    expect(
      visibleFileTreeRows(tree, new Set(["web/nested"])).map(
        ({ node }) => node.name,
      ),
    ).toEqual(["web", "a.ts", "nested", "README.md"]);
    expect(
      visibleFileTreeRows(tree, new Set(["web"])).map(({ node }) => node.name),
    ).toEqual(["web", "README.md"]);
  });
});
