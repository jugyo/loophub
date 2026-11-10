// remark plugin: turn every soft line break in Markdown text into a hard one, the way GitHub
// renders comments. Only `text` nodes carry soft breaks; code holds its content in `value` on
// distinct node types, so code blocks and inline code are untouched.

import { visit } from "unist-util-visit";

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
}

export function remarkBreaks() {
  return (tree: MdNode) => {
    visit(
      tree,
      "text",
      (node: MdNode, index: number | undefined, parent: MdNode | undefined) => {
        if (index === undefined || !parent?.children) return;
        const lines = (node.value ?? "").split(/\r?\n|\r/);
        if (lines.length === 1) return;
        const replacement = lines.flatMap<MdNode>((value, i) =>
          i === 0
            ? [{ type: "text", value }]
            : [{ type: "break" }, { type: "text", value }],
        );
        parent.children.splice(index, 1, ...replacement);
        return index + replacement.length;
      },
    );
  };
}
