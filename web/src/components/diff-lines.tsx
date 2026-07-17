// Patch body rendering shared by the PR file diff and the commit diff dialog: the parsed patch
// lines tinted per kind, or an empty-diff note when the patch carries no text.

import { type DiffLineKind, parsePatch } from "@/lib/diff";

const DIFF_LINE_CLASS: Record<DiffLineKind, string> = {
  add: "bg-green-500/10 text-green-700 dark:text-green-300",
  del: "bg-red-500/10 text-red-700 dark:text-red-300",
  hunk: "bg-muted text-muted-foreground",
  meta: "text-muted-foreground",
  context: "",
};

export function DiffLines({ patch }: { patch: string | undefined | null }) {
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
          {l.text || " "}
        </span>
      ))}
    </pre>
  );
}
