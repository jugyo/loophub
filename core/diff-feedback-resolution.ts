export type DiffFeedbackOutdatedReason = "deleted" | "modified" | "ambiguous";

export type DiffFeedbackRangeResolution =
  | {
      status: "current";
      startLine: number;
      endLine: number;
      match: "lcs" | "exact" | "fuzzy";
    }
  | { status: "outdated"; reason: DiffFeedbackOutdatedReason };

export const DIFF_FEEDBACK_FUZZY_MIN_LENGTH = 8;
export const DIFF_FEEDBACK_FUZZY_MIN_SIMILARITY = 0.8;

function lcsLengths(left: string[], right: string[]): Uint32Array {
  let previous = new Uint32Array(right.length + 1);
  for (const leftLine of left) {
    const current = new Uint32Array(right.length + 1);
    for (let j = 1; j <= right.length; j += 1) {
      current[j] =
        leftLine === right[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous;
}

/**
 * Deterministic Hirschberg LCS alignment. It retains the line mapping needed by anchor resolution
 * without allocating a file-size-squared matrix.
 */
function lcsLineMapWithTieBreak(
  original: string[],
  current: string[],
  preferLast = false,
): Map<number, number> {
  const pairs: [number, number][] = [];

  function align(
    originalStart: number,
    originalEnd: number,
    currentStart: number,
    currentEnd: number,
  ) {
    if (originalStart >= originalEnd || currentStart >= currentEnd) return;
    if (originalEnd - originalStart === 1) {
      const currentSlice = current.slice(currentStart, currentEnd);
      const match = preferLast
        ? currentSlice.lastIndexOf(original[originalStart])
        : currentSlice.indexOf(original[originalStart]);
      if (match >= 0) pairs.push([originalStart, currentStart + match]);
      return;
    }

    const originalMiddle = Math.floor((originalStart + originalEnd) / 2);
    const currentSlice = current.slice(currentStart, currentEnd);
    const forward = lcsLengths(
      original.slice(originalStart, originalMiddle),
      currentSlice,
    );
    const backward = lcsLengths(
      original.slice(originalMiddle, originalEnd).reverse(),
      currentSlice.toReversed(),
    );
    let split = 0;
    let best = -1;
    for (let offset = 0; offset <= currentSlice.length; offset += 1) {
      const score = forward[offset] + backward[currentSlice.length - offset];
      if (score > best || (preferLast && score === best)) {
        best = score;
        split = offset;
      }
    }
    const currentMiddle = currentStart + split;
    align(originalStart, originalMiddle, currentStart, currentMiddle);
    align(originalMiddle, originalEnd, currentMiddle, currentEnd);
  }

  align(0, original.length, 0, current.length);
  return new Map(pairs);
}

export function lcsLineMap(
  original: string[],
  current: string[],
): Map<number, number> {
  return lcsLineMapWithTieBreak(original, current);
}

function predictedStarts(
  mapping: Map<number, number>,
  originalStart: number,
  originalEnd: number,
  currentLength: number,
): number[] {
  let before: { current: number; original: number } | undefined;
  let after: { current: number; original: number } | undefined;
  for (const [original, current] of mapping) {
    if (original < originalStart && (!before || original > before.original)) {
      before = { current, original };
    }
    if (original >= originalEnd && (!after || original < after.original)) {
      after = { current, original };
    }
  }
  const predictions = [
    before ? originalStart + (before.current - before.original) : undefined,
    after ? originalStart + (after.current - after.original) : undefined,
  ]
    .filter((prediction): prediction is number => prediction != null)
    .map((prediction) => Math.max(0, Math.min(prediction, currentLength)));
  return [...new Set(predictions.length > 0 ? predictions : [originalStart])];
}

function exactCandidates(haystack: string[], needle: string[]): number[] {
  if (needle.length === 0 || needle.length > haystack.length) return [];
  const candidates: number[] = [];
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    if (needle.every((line, offset) => haystack[start + offset] === line)) {
      candidates.push(start);
    }
  }
  return candidates;
}

function similarity(left: string, right: string): number {
  if (left === right) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  let previous = Uint32Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Uint32Array(right.length + 1);
    current[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length);
}

/**
 * Resolve an immutable one-based anchor range from its saved file content onto current content.
 * Exact search may move code within the file; fuzzy matching is deliberately limited to the LCS
 * prediction so similar-looking code elsewhere cannot capture the conversation.
 */
export function resolveDiffFeedbackRange(
  original: string[],
  current: string[],
  startLine: number,
  endLine: number,
): DiffFeedbackRangeResolution {
  const start = startLine - 1;
  const length = endLine - startLine + 1;
  if (
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    start < 0 ||
    length < 1 ||
    endLine > original.length
  ) {
    return { status: "outdated", reason: "deleted" };
  }

  const anchor = original.slice(start, start + length);
  const mapping = lcsLineMap(original, current);
  // Hirschberg must choose among equally long alignments. Comparing both deterministic extremes
  // prevents that arbitrary tie-break from making one duplicate anchor look uniquely closest.
  const alternateMapping = lcsLineMapWithTieBreak(original, current, true);
  const mapped = anchor.map((_, offset) => mapping.get(start + offset));
  const alternateMapped = anchor.map((_, offset) =>
    alternateMapping.get(start + offset),
  );
  const mappedContiguously = mapped.every(
    (line, offset) => line != null && line === mapped[0]! + offset,
  );
  const candidates = exactCandidates(current, anchor);
  if (mappedContiguously && candidates.length === 1) {
    return {
      status: "current",
      startLine: mapped[0]! + 1,
      endLine: mapped[0]! + length,
      match: "lcs",
    };
  }

  const primaryPredictions = predictedStarts(
    mapping,
    start,
    start + length,
    current.length,
  );
  const alternatePredictions = predictedStarts(
    alternateMapping,
    start,
    start + length,
    current.length,
  );
  const predictions = [
    ...new Set([...primaryPredictions, ...alternatePredictions]),
  ];
  if (candidates.length > 0) {
    const lcsPredictionIsAmbiguous =
      mapped.some((line, offset) => line !== alternateMapped[offset]) ||
      primaryPredictions.some(
        (prediction) => !alternatePredictions.includes(prediction),
      ) ||
      alternatePredictions.some(
        (prediction) => !primaryPredictions.includes(prediction),
      );
    if (candidates.length > 1 && lcsPredictionIsAmbiguous) {
      return { status: "outdated", reason: "ambiguous" };
    }
    const ranked = candidates
      .map((candidate) => ({
        candidate,
        distance: predictions.reduce(
          (total, prediction) => total + Math.abs(candidate - prediction),
          0,
        ),
      }))
      .sort(
        (left, right) =>
          left.distance - right.distance || left.candidate - right.candidate,
      );
    if (ranked.length === 1 || ranked[0].distance < ranked[1].distance) {
      return {
        status: "current",
        startLine: ranked[0].candidate + 1,
        endLine: ranked[0].candidate + length,
        match:
          mappedContiguously && ranked[0].candidate === mapped[0]
            ? "lcs"
            : "exact",
      };
    }
    return { status: "outdated", reason: "ambiguous" };
  }

  const anchorText = anchor.join("\n");
  const fuzzyCandidates =
    anchorText.length < DIFF_FEEDBACK_FUZZY_MIN_LENGTH
      ? []
      : predictions.filter((prediction) => {
          const predictedLines = current.slice(prediction, prediction + length);
          return (
            predictedLines.length === length &&
            similarity(anchorText, predictedLines.join("\n")) >=
              DIFF_FEEDBACK_FUZZY_MIN_SIMILARITY
          );
        });
  if (fuzzyCandidates.length === 1) {
    return {
      status: "current",
      startLine: fuzzyCandidates[0] + 1,
      endLine: fuzzyCandidates[0] + length,
      match: "fuzzy",
    };
  }
  if (fuzzyCandidates.length > 1) {
    return { status: "outdated", reason: "ambiguous" };
  }

  const before = mapping.get(start - 1);
  const after = mapping.get(start + length);
  return {
    status: "outdated",
    reason:
      before != null && after != null && after === before + 1
        ? "deleted"
        : "modified",
  };
}
