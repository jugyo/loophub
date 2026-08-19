// #344: the change map's document — the structured account of a PR's whole change that the reader
// descends through, from category to change to file to diff.
//
// Structured rather than Markdown prose because coverage is the point of this feature. Each change
// declares the files it covers, so "what does this map not reach?" is an exact set difference
// against the PR's changed files, not a guess made by scanning text for path-shaped substrings. It
// is also the single representation: carrying prose *and* structure would mean two descriptions of
// the same change that can disagree, which is precisely the defect the first attempt shipped.
//
// Node-free and side-effect free: the web imports it directly for its wire types and its reader,
// the same way it imports core/runtimes.ts.

/** Current document version. A stored document always carries the version it was written as. */
export const CHANGE_MAP_VERSION = 1;

/**
 * The most categories a map may have.
 *
 * An upper bound, not a target. Without one an LLM reproduces the directory tree — `core/`, `cli/`,
 * `web/` — which renames the file list instead of abstracting over it; the cap is what forces the
 * grouping work. There is deliberately no lower bound: a three-file PR should not be padded out.
 * Breadth beyond six belongs to the level below, which is uncapped, rather than to a seventh
 * catch-all category.
 */
export const CHANGE_MAP_MAX_CATEGORIES = 6;

/** One file a change covers, and optionally what this change did to it. */
export interface ChangeMapFile {
  /** Repo-relative path, exactly as git prints it. */
  path: string;
  /** What this change did to this file, read above its diff. Most files do not need one. */
  summary?: string;
}

/** One unit of change: a thing that was done, and the files it was done in. */
export interface ChangeMapChange {
  name: string;
  /** What kind of thing it is — "migration", "JSON-RPC method", "UI component", … Free text. */
  kind: string;
  summary: string;
  /** The files this change covers. The entry point into the diffs. */
  files: ChangeMapFile[];
  /** What verifies this change, and what is left uncovered. */
  tests?: string;
  /** What a reviewer should look at, and the risks. */
  risk?: string;
}

/** A group of related changes — the top level a reader starts from. */
export interface ChangeMapCategory {
  name: string;
  summary: string;
  changes: ChangeMapChange[];
}

export interface ChangeMapDocument {
  version: number;
  /** What the PR did, in one line. */
  summary: string;
  categories: ChangeMapCategory[];
}

/** Raised by `parseChangeMapDocument`; the message names what is wrong and where. */
export class ChangeMapDocumentError extends Error {}

function fail(message: string): never {
  throw new ChangeMapDocumentError(message);
}

function record(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function text(
  value: unknown,
  where: string,
  { optional = false } = {},
): string | undefined {
  if (value == null && optional) return undefined;
  if (typeof value !== "string") fail(`${where} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (optional) return undefined;
    fail(`${where} must not be empty`);
  }
  return trimmed;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (value.length === 0) fail(`${where} must not be empty`);
  return value;
}

// A file entry is either the bare path or an object carrying a note about it. Both forms are
// accepted because the note is the exception: most files need nothing said about them, and making
// every entry an object would triple the size of a document to express nothing.
function parseFile(value: unknown, where: string): ChangeMapFile {
  if (typeof value === "string" || value == null)
    return { path: text(value, where) as string };
  const raw = record(value, where);
  const summary = text(raw.summary, `${where}.summary`, { optional: true });
  return {
    path: text(raw.path, `${where}.path`) as string,
    ...(summary ? { summary } : {}),
  };
}

function parseChange(value: unknown, where: string): ChangeMapChange {
  const raw = record(value, where);
  const files = list(raw.files, `${where}.files`).map((file, i) =>
    parseFile(file, `${where}.files[${i}]`),
  );
  return {
    name: text(raw.name, `${where}.name`) as string,
    kind: text(raw.kind, `${where}.kind`) as string,
    summary: text(raw.summary, `${where}.summary`) as string,
    files,
    tests: text(raw.tests, `${where}.tests`, { optional: true }),
    risk: text(raw.risk, `${where}.risk`, { optional: true }),
  };
}

function parseCategory(value: unknown, where: string): ChangeMapCategory {
  const raw = record(value, where);
  return {
    name: text(raw.name, `${where}.name`) as string,
    summary: text(raw.summary, `${where}.summary`) as string,
    changes: list(raw.changes, `${where}.changes`).map((change, i) =>
      parseChange(change, `${where}.changes[${i}]`),
    ),
  };
}

/**
 * Validate a change map document and return it normalized (strings trimmed, absent optionals
 * dropped), or throw `ChangeMapDocumentError` naming the first problem.
 *
 * What is checked is that the document is *well formed* — not that it is complete. A map that
 * leaves files unmentioned still saves: incompleteness is shown to the reader as Not covered, and
 * a save that rejected it would only mean an agent that cannot record what it did manage to work
 * out. Structural damage is different, and there is nothing useful to do with it but refuse.
 */
export function parseChangeMapDocument(value: unknown): ChangeMapDocument {
  const raw = record(value, "document");
  if (raw.version !== CHANGE_MAP_VERSION)
    fail(
      `document.version must be ${CHANGE_MAP_VERSION} (got ${JSON.stringify(raw.version)})`,
    );
  const categories = list(raw.categories, "document.categories");
  if (categories.length > CHANGE_MAP_MAX_CATEGORIES)
    fail(
      `document.categories must hold at most ${CHANGE_MAP_MAX_CATEGORIES} categories (got ${categories.length}); merge the finest distinctions into changes inside a category rather than adding another one`,
    );
  return {
    version: CHANGE_MAP_VERSION,
    summary: text(raw.summary, "document.summary") as string,
    categories: categories.map((category, i) =>
      parseCategory(category, `document.categories[${i}]`),
    ),
  };
}

/** Parse a stored/transmitted document from its JSON text. */
export function parseChangeMapDocumentText(source: string): ChangeMapDocument {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(
      `document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseChangeMapDocument(value);
}

/** Every path the document declares, in document order, deduplicated. */
export function changeMapDocumentPaths(
  document: ChangeMapDocument,
): Set<string> {
  const paths = new Set<string>();
  for (const category of document.categories) {
    for (const change of category.changes) {
      for (const file of change.files) paths.add(file.path);
    }
  }
  return paths;
}
