// Pure helpers for rendering a unified-diff patch (GET .../pulls/{n}/files).
// Ported from the v1 UI (src/ui.html diffHtml) for parity, kept dependency-free
// so diff classification is unit-testable without React.

export type DiffLineKind = "add" | "del" | "hunk" | "meta" | "context";

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}

export interface PositionedDiffLine extends DiffLine {
  oldLine: number | null;
  newLine: number | null;
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
  if (line.startsWith("\\ No newline at end of file")) return "meta";
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

/** Parse a unified patch while tracking old/new coordinates from each hunk header. */
export function parsePositionedPatch(
  patch: string | undefined | null,
): PositionedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;

  return parsePatch(patch).map((line) => {
    if (line.kind === "hunk") {
      const range = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line.text);
      if (range) {
        oldLine = Number(range[1]);
        newLine = Number(range[2]);
      }
      return { ...line, oldLine: null, newLine: null };
    }
    if (line.kind === "add") {
      const positioned = { ...line, oldLine: null, newLine };
      newLine += 1;
      return positioned;
    }
    if (line.kind === "del") {
      const positioned = { ...line, oldLine, newLine: null };
      oldLine += 1;
      return positioned;
    }
    if (line.kind === "context") {
      const positioned = { ...line, oldLine, newLine };
      oldLine += 1;
      newLine += 1;
      return positioned;
    }
    return { ...line, oldLine: null, newLine: null };
  });
}
