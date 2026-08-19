import { Check, Copy, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { PrTestMap, PullFile } from "@/api/types";
import { Markdown } from "@/components/markdown";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/time";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { cn } from "@/lib/utils";
import type { TestMapTest } from "../../../core/test-map-document.ts";
import {
  isTestFilePath,
  testMapDocumentPaths,
  testMapMarkdown,
} from "../../../core/test-map-document.ts";

// #348: the test map, read as a listing. Two panes: the tree of test file → describe hierarchy →
// test title on the left, and on the right the code of whichever test is selected, with the
// implementation it exercises under it.
//
// Two panes rather than the change map's four columns because the map's shape is different. A
// change map is navigated — the reader descends through it looking for a diff. A test map is read:
// the left pane is the whole listing at once, since reading the titles top to bottom is most of
// what the map is for, and the right pane is the detail for the one the reader stopped on.
//
// What the map does not mention is shown as Not covered at the end of the tree, so a PR whose map
// missed a test file says so instead of reading as a PR with fewer tests than it has.

export function PrTestMapDialog({
  testMap,
  files,
  headSha,
  onOpenFile,
  onClose,
}: {
  testMap: PrTestMap;
  /** The PR's changed files, or undefined while they are still loading. */
  files: PullFile[] | undefined;
  /** The PR's live head, for the stale badge. */
  headSha: string | null;
  onOpenFile: (filename: string) => void;
  onClose: () => void;
}) {
  const backdropDismiss = useBackdropDismiss(onClose);
  const [at, setAt] = useState({ file: 0, test: 0 });

  const document = testMap.document;
  // The changed test files the map never mentions. Only test files: an implementation file the map
  // does not name is not a hole in a listing of tests, and offering every changed file here would
  // bury the ones that are.
  const notCovered = useMemo(() => {
    if (!files) return [];
    const listed = testMapDocumentPaths(document);
    return files.filter(
      (file) => isTestFilePath(file.filename) && !listed.has(file.filename),
    );
  }, [document, files]);

  const file = document.files[Math.min(at.file, document.files.length - 1)];
  const test = file?.tests[Math.min(at.test, file.tests.length - 1)];
  const isStale = !!headSha && headSha !== testMap.head_sha;
  const changed = useMemo(
    () => new Set((files ?? []).map((f) => f.filename)),
    [files],
  );
  // A saved map outlives the head it was written against, so it can name a path the PR no longer
  // changes. Those rows must not pretend to lead to a diff.
  const openable = (path: string) =>
    files ? (changed.has(path) ? () => onOpenFile(path) : null) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-background/80 p-2 backdrop-blur-sm sm:p-4"
      {...backdropDismiss}
    >
      <div
        data-debug-component="PrTestMapDialog"
        role="dialog"
        aria-modal="true"
        aria-label="Test map"
        className="flex max-h-full w-full flex-col overflow-hidden rounded-md border bg-background shadow-lg"
      >
        <header className="flex items-start justify-between gap-3 border-b px-5 py-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex min-w-0 items-baseline gap-2">
              <h2 className="text-base font-semibold">Test map</h2>
              <span className="truncate font-mono text-xs text-muted-foreground">
                {testMap.head_sha.slice(0, 7)} ·{" "}
                {relativeTime(testMap.created_at)}
              </span>
              {isStale ? (
                <span
                  className="whitespace-nowrap rounded border border-amber-500/50 bg-amber-500/10 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-400"
                  title={`Written against ${testMap.head_sha.slice(0, 7)}; the PR head is now ${headSha?.slice(0, 7)}. The excerpts are the code as it stood then.`}
                >
                  Stale
                </span>
              ) : null}
            </div>
            <Prose className="text-sm text-muted-foreground">
              {document.summary}
            </Prose>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <CopyMarkdownButton value={() => testMapMarkdown(document)} />
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close"
              onClick={onClose}
            >
              <X className="size-4" />
            </Button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-96 shrink-0 flex-col border-r">
            <PaneHeader
              label="Tests"
              count={document.files.reduce(
                (total, entry) => total + entry.tests.length,
                0,
              )}
            />
            <nav
              aria-label="Test map tree"
              className="min-h-0 flex-1 overflow-y-auto"
            >
              {document.files.map((entry, fileIndex) => (
                <section key={entry.path}>
                  <FilePathRow
                    path={entry.path}
                    onOpen={openable(entry.path)}
                    className="sticky top-0 z-10 border-y bg-muted/60 first:border-t-0"
                  />
                  <ul>
                    {entry.tests.map((item, testIndex) => (
                      <li key={`${testIndex}:${item.title}`}>
                        {suiteHeadingFor(entry.tests, testIndex)}
                        <button
                          type="button"
                          aria-current={item === test}
                          onClick={() =>
                            setAt({ file: fileIndex, test: testIndex })
                          }
                          className="flex w-full flex-col gap-0.5 px-3 py-1.5 pl-6 text-left text-sm hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-[current=true]:bg-accent"
                        >
                          <span className="min-w-0">{item.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
              {notCovered.length > 0 ? (
                <section aria-label={`Not covered (${notCovered.length})`}>
                  {/* The map's own blind spot, kept where the reader is already looking rather
                      than in a separate view they would have to know to open. */}
                  <div className="sticky top-0 z-10 border-y bg-amber-500/10 px-3 py-1.5 text-xs font-medium text-amber-700 dark:text-amber-400">
                    Not covered ({notCovered.length})
                  </div>
                  <p className="px-3 py-1.5 text-xs text-muted-foreground">
                    Changed test files the map does not list.
                  </p>
                  <ul>
                    {notCovered.map((entry) => (
                      <li key={entry.filename}>
                        <FilePathRow
                          path={entry.filename}
                          onOpen={openable(entry.filename)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </nav>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <PaneHeader label="Test" />
            <div className="min-h-0 flex-1 overflow-auto">
              {test && file ? (
                <div className="flex flex-col gap-4 p-4">
                  <div className="flex flex-col gap-1">
                    {test.suites.length ? (
                      <p className="text-xs text-muted-foreground">
                        {test.suites.join(" › ")}
                      </p>
                    ) : null}
                    <h3 className="text-sm font-semibold">{test.title}</h3>
                    <Prose className="text-sm text-muted-foreground">
                      {test.summary}
                    </Prose>
                  </div>
                  <Excerpt
                    label="Test"
                    path={file.path}
                    code={test.code}
                    onOpen={openable(file.path)}
                  />
                  {/* The implementation under the test, when the map could point at one. It sits
                      below the test because the test is what the reader came for; the
                      implementation is the answer to "what does this actually exercise?". */}
                  {test.target ? (
                    <Excerpt
                      label="Implementation"
                      path={test.target.path}
                      code={test.target.code}
                      onOpen={openable(test.target.path)}
                    />
                  ) : null}
                </div>
              ) : (
                <p className="px-3 py-3 text-sm text-muted-foreground">
                  Pick a test to see its code.
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// The describe path above a test, printed once where it starts rather than on every row — repeated
// on each test it would be the loudest thing in a pane whose point is the titles.
function suiteHeadingFor(tests: TestMapTest[], index: number): ReactNode {
  const path = tests[index].suites.join(" › ");
  const previous = index > 0 ? tests[index - 1].suites.join(" › ") : null;
  if (!path || path === previous) return null;
  return (
    <div className="px-3 py-1 pl-4 text-xs font-medium text-muted-foreground">
      {path}
    </div>
  );
}

// A path that opens its diff without closing the map — the map is what the reader is reading, and
// the diff is the aside. `onOpen` is null for a path this PR does not change, which a saved map can
// still name once the head has moved.
function FilePathRow({
  path,
  onOpen,
  className,
}: {
  path: string;
  onOpen: (() => void) | null;
  className?: string;
}) {
  if (!onOpen) {
    return (
      <div
        className={cn(
          "px-3 py-1.5 font-mono text-xs text-muted-foreground",
          className,
        )}
        title={`${path} is listed by the map but is not in this PR's diff`}
      >
        {path}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      title={`Open the diff for ${path}`}
      className={cn(
        "block w-full truncate px-3 py-1.5 text-left font-mono text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
    >
      {path}
    </button>
  );
}

// A verbatim excerpt, shown as it was read from the file at the map's head — no wrapping, no
// re-indentation, so what is on screen is what is in the repository.
function Excerpt({
  label,
  path,
  code,
  onOpen,
}: {
  label: string;
  path: string;
  code: string;
  onOpen: (() => void) | null;
}) {
  return (
    <div className="overflow-hidden rounded-md border">
      <div className="flex items-baseline gap-2 border-b bg-muted/40 px-3 py-1.5">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <FilePathRow path={path} onOpen={onOpen} className="min-w-0 flex-1" />
      </div>
      <pre className="overflow-x-auto px-3 py-2 font-mono text-xs leading-relaxed">
        {code}
      </pre>
    </div>
  );
}

// The document's prose is written by an LLM, which reaches for Markdown without being asked, so it
// goes through the same renderer as every other body on the page (as in the change map dialog).
function Prose({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <Markdown className={cn("markdown-compact", className)}>
      {children}
    </Markdown>
  );
}

function PaneHeader({ label, count }: { label: string; count?: number }) {
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      <span className="min-w-0 truncate">{label}</span>
      {count == null ? null : <span>{count}</span>}
    </div>
  );
}

// Markdown is generated from the document at the moment of the copy (core/test-map-document.ts),
// never stored — the document is the single representation, and a second copy of it in another
// format is a second thing that can disagree with it.
function CopyMarkdownButton({ value }: { value: () => string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="gap-1.5"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value());
          setCopied(true);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1500);
        } catch {
          // Clipboard API unavailable (insecure context / denied). Nothing to recover — the map is
          // still on screen to read.
        }
      }}
    >
      {copied ? (
        <Check className="size-3.5 text-green-600 dark:text-green-400" />
      ) : (
        <Copy className="size-3.5" />
      )}
      {copied ? "Copied" : "Copy as Markdown"}
    </Button>
  );
}
