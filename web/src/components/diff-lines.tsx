// Patch body rendering shared by the PR file diff and the commit diff dialog: the parsed patch
// lines tinted per kind, or an empty-diff note when the patch carries no text.

import type { PullFile } from "@/api/types";
import { type DiffLineKind, parsePatch } from "@/lib/diff";
import { SyntaxHighlightedCode } from "@/lib/syntax-highlight";

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-green-100 text-green-900 dark:bg-green-950 dark:text-green-100",
  del: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-100",
  hunk: "bg-muted text-muted-foreground",
  meta: "text-muted-foreground",
  context: "",
};

export function DiffLines({
  filename: _filename,
  patch,
  syntaxHighlight,
}: {
  filename: string;
  patch: string | undefined | null;
  syntaxHighlight?: PullFile["syntax_highlight"];
}) {
  const lines = parsePatch(patch);
  if (lines.length === 0) {
    return (
      <p className="px-3 py-2 text-xs text-muted-foreground">
        No textual diff.
      </p>
    );
  }
  return (
    <pre className="pr-diff overflow-x-auto text-xs leading-relaxed">
      {lines.map((l, i) => (
        <span key={i} className={`block px-3 ${DIFF_LINE_CLASS[l.kind]}`}>
          {l.kind === "add" || l.kind === "del" || l.kind === "context" ? (
            <>
              <span className="sr-only">{l.text}</span>
              <span
                aria-hidden="true"
                className="pr-diff-line-content"
                data-diff-marker={
                  l.kind === "add"
                    ? "+"
                    : l.kind === "del"
                      ? "-"
                      : l.text.startsWith(" ")
                        ? " "
                        : ""
                }
              >
                <SyntaxHighlightedCode
                  code={l.text.slice(1) || " "}
                  language={syntaxHighlight?.language}
                  tokens={
                    syntaxHighlight?.lines[i]?.[
                      l.kind === "add" ? "new" : "old"
                    ]
                  }
                />
              </span>
            </>
          ) : (
            l.text || " "
          )}
        </span>
      ))}
    </pre>
  );
}
