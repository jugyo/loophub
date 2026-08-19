// #348: the test map's document — what a PR's tests verify, listed so a reader can take in the
// tests without reading the diff. Reading the test titles alone usually tells you what the PR
// implemented, and whether it was tested at all is the quality signal worth the least attention.
//
// Structured rather than Markdown prose for the same two reasons the change map is (#344): the
// test files a map accounts for are declared rather than guessed from text, so "which changed test
// file does this map not mention?" is an exact set difference; and there is one representation, so
// prose and structure cannot disagree. The Markdown a reader copies is generated from the document
// here, never stored alongside it.
//
// The code excerpts are verbatim — read out of the real files at `head_sha` by the generating
// agent, not written by the model. A rewritten excerpt would be a plausible-looking test that does
// not exist, which is worse than no excerpt at all. Nothing here can enforce that; what it can do
// is keep the excerpts whole (no trimming of indentation) so a mismatch is visible.
//
// Node-free and side-effect free: the web imports it directly for its wire types, its tree, and
// its Markdown, the same way it imports core/change-map-document.ts.

/** Current document version. A stored document always carries the version it was written as. */
export const TEST_MAP_VERSION = 1;

/** The implementation a test exercises, as it stood at the map's head. */
export interface TestMapTarget {
  /** Repo-relative path, exactly as git prints it. */
  path: string;
  /** Verbatim excerpt of that file. */
  code: string;
}

/** One test: where it sits, what it verifies, and the code that does it. */
export interface TestMapTest {
  /** The describe / context titles above it, outermost first. Flat tests have none. */
  suites: string[];
  title: string;
  /** What this test verifies, in one line. */
  summary: string;
  /** Verbatim excerpt of the test, read from the file at the map's head. */
  code: string;
  /** The implementation it exercises, when one can be pointed at. */
  target?: TestMapTarget;
}

/** One test file and the tests the map accounts for in it. */
export interface TestMapFile {
  /** Repo-relative path, exactly as git prints it. */
  path: string;
  tests: TestMapTest[];
}

export interface TestMapDocument {
  version: number;
  /** What this PR's tests cover, in one line. */
  summary: string;
  files: TestMapFile[];
}

/** Raised by `parseTestMapDocument`; the message names what is wrong and where. */
export class TestMapDocumentError extends Error {}

function fail(message: string): never {
  throw new TestMapDocumentError(message);
}

function record(
  value: unknown,
  where: string,
): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${where} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${where} must not be empty`);
  return trimmed;
}

// A code excerpt keeps its interior exactly as it was read: indentation is part of what makes an
// excerpt recognizable as the real thing. Only the blank lines around it are dropped, since those
// come from how the agent sliced the file rather than from the file.
function code(value: unknown, where: string): string {
  if (typeof value !== "string") fail(`${where} must be a string`);
  const trimmed = value.replace(/^[ \t]*\n+/, "").trimEnd();
  if (!trimmed.trim()) fail(`${where} must not be empty`);
  return trimmed;
}

function list(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  if (value.length === 0) fail(`${where} must not be empty`);
  return value;
}

function parseTarget(value: unknown, where: string): TestMapTarget | undefined {
  if (value == null) return undefined;
  const raw = record(value, where);
  return {
    path: text(raw.path, `${where}.path`),
    code: code(raw.code, `${where}.code`),
  };
}

// `suites` is optional and may be empty: a file of top-level tests (the common shape in this repo)
// has no describe to report, and requiring one would mean inventing a heading.
function parseSuites(value: unknown, where: string): string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) fail(`${where} must be an array`);
  return value.map((suite, i) => text(suite, `${where}[${i}]`));
}

function parseTest(value: unknown, where: string): TestMapTest {
  const raw = record(value, where);
  const target = parseTarget(raw.target, `${where}.target`);
  return {
    suites: parseSuites(raw.suites, `${where}.suites`),
    title: text(raw.title, `${where}.title`),
    summary: text(raw.summary, `${where}.summary`),
    code: code(raw.code, `${where}.code`),
    ...(target ? { target } : {}),
  };
}

function parseFile(value: unknown, where: string): TestMapFile {
  const raw = record(value, where);
  return {
    path: text(raw.path, `${where}.path`),
    tests: list(raw.tests, `${where}.tests`).map((test, i) =>
      parseTest(test, `${where}.tests[${i}]`),
    ),
  };
}

/**
 * Validate a test map document and return it normalized, or throw `TestMapDocumentError` naming the
 * first problem.
 *
 * What is checked is that the document is *well formed*, not that it covers every test the PR
 * added. A map that misses a test file still saves: the dialog shows what it missed as Not covered,
 * and refusing the save would only mean losing the tests the agent did work out. Structural damage
 * is different — there is nothing useful to do with it but refuse while the agent can try again.
 */
export function parseTestMapDocument(value: unknown): TestMapDocument {
  const raw = record(value, "document");
  if (raw.version !== TEST_MAP_VERSION)
    fail(
      `document.version must be ${TEST_MAP_VERSION} (got ${JSON.stringify(raw.version)})`,
    );
  return {
    version: TEST_MAP_VERSION,
    summary: text(raw.summary, "document.summary"),
    files: list(raw.files, "document.files").map((file, i) =>
      parseFile(file, `document.files[${i}]`),
    ),
  };
}

/** Parse a stored/transmitted document from its JSON text. */
export function parseTestMapDocumentText(source: string): TestMapDocument {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch (error) {
    fail(
      `document is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return parseTestMapDocument(value);
}

/** Every test file path the document accounts for, in document order, deduplicated. */
export function testMapDocumentPaths(document: TestMapDocument): Set<string> {
  return new Set(document.files.map((file) => file.path));
}

/** How many tests the document lists across all of its files. */
export function testMapTestCount(document: TestMapDocument): number {
  return document.files.reduce((total, file) => total + file.tests.length, 0);
}

/**
 * Whether a repo-relative path looks like a test file.
 *
 * Used only to decide what belongs in Not covered — the changed test files the map never mentions.
 * A heuristic is the right shape for that: being wrong means offering one file too many or too few
 * in a list whose whole purpose is to be looked over by a human, and no naming rule is knowable
 * across languages anyway.
 */
export function isTestFilePath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/(^|[._-])(test|spec)s?\.[^.]+$/i.test(name)) return true;
  if (/^(test|spec)_/i.test(name)) return true;
  return path
    .split("/")
    .slice(0, -1)
    .some((segment) => /^(__tests__|__specs__|tests?|specs?)$/i.test(segment));
}

// Fence languages worth naming. An unknown extension gets a bare fence rather than a guess, which
// renders the same everywhere minus the highlighting.
const FENCE_LANGUAGES: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  mts: "ts",
  cts: "ts",
  js: "js",
  jsx: "jsx",
  mjs: "js",
  cjs: "js",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  php: "php",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cs: "csharp",
  sh: "sh",
  sql: "sql",
};

function fenceLanguage(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return FENCE_LANGUAGES[extension] ?? "";
}

// A fence has to be longer than the longest run of backticks inside what it wraps, or an excerpt
// containing a fence of its own ends the block early.
function fence(source: string): string {
  const longest = Math.max(
    0,
    ...[...source.matchAll(/`+/g)].map((match) => match[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

function codeBlock(path: string, source: string): string {
  const ticks = fence(source);
  return `${ticks}${fenceLanguage(path)}\n${source}\n${ticks}`;
}

/**
 * The document as Markdown, for pasting somewhere else.
 *
 * Generated on demand rather than stored: Markdown is a rendering of the document, and keeping a
 * second copy of it would let the two disagree the moment either changes. The tree the dialog shows
 * as panes becomes headings here — file, then the describe path, then the test — so a paste reads
 * as the same structure in anything that renders Markdown.
 */
export function testMapMarkdown(document: TestMapDocument): string {
  const lines: string[] = ["# Test map", "", document.summary];
  for (const file of document.files) {
    lines.push("", `## ${file.path}`);
    let suites: string | null = null;
    for (const test of file.tests) {
      const path = test.suites.join(" › ");
      if (path && path !== suites) lines.push("", `### ${path}`);
      // A file that mixes suites with top-level tests must not leave the later ones reading as
      // part of the suite above them.
      if (!path && suites) lines.push("", `### (top level)`);
      suites = path || null;
      lines.push("", `#### ${test.title}`, "", test.summary, "");
      lines.push(codeBlock(file.path, test.code));
      if (test.target) {
        lines.push("", `Implementation — \`${test.target.path}\``, "");
        lines.push(codeBlock(test.target.path, test.target.code));
      }
    }
  }
  return `${lines.join("\n")}\n`;
}
