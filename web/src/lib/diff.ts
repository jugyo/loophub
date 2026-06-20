// Pure helpers for rendering a unified-diff patch (GET .../pulls/{n}/files).
// Ported from the v1 UI (src/ui.html diffHtml) for parity, kept dependency-free
// so diff classification is unit-testable without React.

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

/**
 * Classify one unified-diff line. `@@` hunk headers, `+`/`-` add/del, and the
 * file-header markers (`+++`/`---`/`diff`/`index`) are distinguished so the
 * renderer can color them; everything else is context.
 */
export function classifyDiffLine(line: string): DiffLineKind {
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("diff ") || line.startsWith("index ")) return "meta";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "context";
}

/** Split a patch into classified lines. Empty/absent patch -> no lines. */
export function parsePatch(patch: string | undefined | null): DiffLine[] {
  if (!patch) return [];
  return patch.split("\n").map((text) => ({
    kind: classifyDiffLine(text),
    text,
  }));
}
