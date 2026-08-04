import type { DiffFeedbackThreadWire } from "./serialize.ts";

interface DiffFileIdentity {
  filename: string;
  headFilename?: string;
  previousFilename?: string;
}

export function selectDiffFeedbackThreads(
  threads: DiffFeedbackThreadWire[],
  files: DiffFileIdentity[],
  scope: { path?: string; orphaned?: boolean },
): DiffFeedbackThreadWire[] {
  const pathsForFile = (file: DiffFileIdentity) =>
    new Set(
      [file.filename, file.headFilename, file.previousFilename].filter(
        (path): path is string => path != null,
      ),
    );
  const selectedFile =
    scope.path == null
      ? null
      : files.find((file) => pathsForFile(file).has(scope.path!));
  const selectedPaths = selectedFile ? pathsForFile(selectedFile) : null;
  const currentPaths = new Set(
    files.flatMap((file) => [...pathsForFile(file)]),
  );

  return threads.filter((thread) => {
    const anchorPaths = [
      thread.anchor.path,
      thread.anchor.original_path,
      thread.resolved_anchor?.path,
      thread.resolved_anchor?.original_path,
    ].filter((path): path is string => path != null);
    if (scope.orphaned)
      return (
        thread.freshness !== "current" &&
        anchorPaths.every((path) => !currentPaths.has(path))
      );
    if (scope.path != null)
      return (
        selectedPaths != null &&
        anchorPaths.some((path) => selectedPaths.has(path))
      );
    return true;
  });
}

/**
 * The threads still waiting on `responders`, i.e. whose newest message none of them wrote.
 *
 * The responding party is the workflow run, not one child session: a run launches a fresh Execute
 * per turn, so a thread answered by an earlier child must not resurface as pending for the next
 * one. Threads without messages cannot exist (creating one writes the first comment), but an empty
 * one would read as unanswered, which is the safe direction.
 *
 * An archived conversation is settled by the human who archived it, so it drops out regardless of
 * who wrote its newest message.
 */
export function selectUnansweredDiffFeedbackThreads<
  T extends Pick<DiffFeedbackThreadWire, "messages" | "archived_at">,
>(threads: T[], responders: ReadonlySet<string>): T[] {
  return threads.filter((thread) => {
    if (thread.archived_at != null) return false;
    const newest = thread.messages.at(-1);
    return !newest || !responders.has(newest.author);
  });
}

export function countDiffFeedbackMessagesByFile(
  threads: DiffFeedbackThreadWire[],
  files: DiffFileIdentity[],
): Record<string, number> {
  return Object.fromEntries(
    files.map((file) => [
      file.filename,
      selectDiffFeedbackThreads(threads, files, {
        path: file.filename,
      }).reduce((sum, thread) => sum + thread.messages.length, 0),
    ]),
  );
}
