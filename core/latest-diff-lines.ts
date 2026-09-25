import { parsePatchWithCoordinates } from "./diff-anchor.ts";
import type { DiffFile } from "./git.ts";

type DiffLine = ReturnType<typeof parsePatchWithCoordinates>[number];

type DeletionLocation = {
  index: number;
  text: string;
  rightPosition: number;
  previous: string | null;
  next: string | null;
};

function deletionLocations(lines: DiffLine[]): DeletionLocation[] {
  const locations: DeletionLocation[] = [];
  let rightPosition = 0;
  let previous: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind === "hunk") {
      rightPosition = Number(/\+(\d+)/.exec(line.text)?.[1] ?? 0);
      previous = null;
      continue;
    }
    if (line.kind === "addition" || line.kind === "context") {
      rightPosition = (line.rightLine ?? rightPosition) + 1;
      previous = line.text;
      continue;
    }
    if (line.kind !== "deletion") continue;
    let next: string | null = null;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const candidate = lines[nextIndex];
      if (candidate.kind === "hunk") break;
      if (candidate.kind === "addition" || candidate.kind === "context") {
        next = candidate.text;
        break;
      }
    }
    locations.push({ index, text: line.text, rightPosition, previous, next });
  }
  return locations;
}

function deletionLocationScore(
  pull: DeletionLocation,
  latest: DeletionLocation,
): number {
  return (
    (pull.rightPosition === latest.rightPosition ? 4 : 0) +
    (pull.previous === latest.previous && pull.previous !== null ? 2 : 0) +
    (pull.next === latest.next && pull.next !== null ? 2 : 0)
  );
}

function deletionLocationKey(location: DeletionLocation): string {
  return JSON.stringify([
    location.text,
    location.rightPosition,
    location.previous,
    location.next,
  ]);
}

/** Mark PR-diff additions/deletions that are also present in the head commit's first-parent diff. */
export function latestChangedLines(
  pullFile: Pick<
    DiffFile,
    "filename" | "headFilename" | "previousFilename" | "patch"
  >,
  latestFiles: DiffFile[],
): Set<number> {
  const paths = new Set(
    [
      pullFile.filename,
      pullFile.headFilename,
      pullFile.previousFilename,
    ].filter((path): path is string => Boolean(path)),
  );
  const latestFile = latestFiles.find((file) =>
    [file.filename, file.headFilename, file.previousFilename].some(
      (path) => path != null && paths.has(path),
    ),
  );
  if (!latestFile) return new Set();

  const latestLines = parsePatchWithCoordinates(latestFile.patch);
  const latestAdditions = new Set(
    latestLines
      .filter((line) => line.kind === "addition")
      .map((line) => `${line.rightLine}\0${line.text}`),
  );
  const pullLines = parsePatchWithCoordinates(pullFile.patch);
  const marked = new Set<number>();
  pullLines.forEach((line: DiffLine, index) => {
    if (
      line.kind === "addition" &&
      latestAdditions.has(`${line.rightLine}\0${line.text}`)
    ) {
      marked.add(index);
      return;
    }
  });
  const available = deletionLocations(pullLines);
  const latestGroups = new Map<string, DeletionLocation[]>();
  for (const latest of deletionLocations(latestLines)) {
    const key = deletionLocationKey(latest);
    latestGroups.set(key, [...(latestGroups.get(key) ?? []), latest]);
  }
  for (const latestGroup of latestGroups.values()) {
    const latest = latestGroup[0];
    const candidates = available.filter(
      (candidate) =>
        candidate.text === latest.text && !marked.has(candidate.index),
    );
    const bestScore = Math.max(
      ...candidates.map((candidate) =>
        deletionLocationScore(candidate, latest),
      ),
    );
    const best = candidates.filter(
      (candidate) => deletionLocationScore(candidate, latest) === bestScore,
    );
    // Equal candidates are unambiguous when the latest diff removed the whole group. If only a
    // subset disappeared, leaving it unmarked is safer than attributing the wrong duplicate.
    if (best.length === latestGroup.length) {
      for (const candidate of best) marked.add(candidate.index);
    }
  }
  return marked;
}
