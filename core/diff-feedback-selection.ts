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
