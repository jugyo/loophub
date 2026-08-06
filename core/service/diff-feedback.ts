import { maybeNotifyAgentComment } from "../agent-comment-notifications.ts";
import { db } from "../db.ts";
import {
  type DiffLine,
  type DiffSide,
  linesAroundAnchor,
  linesForAnchor,
  parsePatchWithCoordinates,
} from "../diff-anchor.ts";
import {
  type DiffFeedbackOutdatedReason,
  resolveDiffFeedbackRange,
} from "../diff-feedback-resolution.ts";
import {
  countDiffFeedbackMessagesByFile,
  selectDiffFeedbackThreads,
} from "../diff-feedback-selection.ts";
import { ServiceError } from "../errors.ts";
import {
  type DiffFile,
  diffFilesBetween,
  fileAtRef,
  localBranchRef,
  revParse,
} from "../git.ts";
import { resolvePullDiffBaseSha } from "../pull-base.ts";
import {
  type DiffFeedbackContextLineWire,
  type DiffFeedbackFreshness,
  type DiffFeedbackPendingWire,
  type DiffFeedbackPlacement,
  type DiffFeedbackThreadDetailWire,
  type DiffFeedbackThreadWire,
  diffFeedbackMessageJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { workflowStepSessionIds } from "../workflow/herdr-agents.ts";
import { SOURCE_PAYLOAD_VERSION } from "../workflow/source-events.ts";
import {
  actorFor,
  commentActor,
  ensureWritable,
  issueOr404,
  repoOr404,
} from "./shared.ts";

const FULL_SHA = /^[0-9a-f]{40}$/i;
export const DIFF_FEEDBACK_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"] as const;

/** Diff lines shown around an anchor when a caller does not ask for a different window. */
const DEFAULT_CONTEXT_RADIUS = 3;

async function currentPair(
  repoPath: string,
  pull: S.PullRow,
): Promise<{ baseSha: string; headSha: string } | null> {
  // Same pair as pulls.diff: live three-dot merge-base + head, not the fork-point base_sha.
  const [baseSha, headSha] = await Promise.all([
    resolvePullDiffBaseSha(repoPath, pull),
    revParse(repoPath, localBranchRef(pull.head_ref)),
  ]);
  return baseSha && headSha ? { baseSha, headSha } : null;
}

function fileForAnchor(
  files: DiffFile[],
  thread: Pick<
    S.DiffFeedbackThreadRow,
    "base_sha" | "head_sha" | "path" | "side"
  >,
) {
  return files.find(
    (file) =>
      (file.headFilename ?? file.filename) === thread.path ||
      (thread.side === "LEFT" &&
        file.previousFilename != null &&
        file.previousFilename === thread.path),
  );
}

function anchorOf(thread: S.DiffFeedbackThreadRow) {
  return {
    side: thread.side as DiffSide,
    startLine: thread.start_line,
    endLine: thread.end_line,
  };
}

function anchorLines(
  files: DiffFile[],
  thread: S.DiffFeedbackThreadRow,
): DiffLine[] | null {
  const file = fileForAnchor(files, thread);
  if (!file) return null;
  return parsePatchWithCoordinates(file.patch);
}

function contextJSON(
  lines: DiffLine[] | null,
  anchor: { side: DiffSide; startLine: number; endLine: number },
  radius: number,
): DiffFeedbackContextLineWire[] | null {
  const window = lines ? linesAroundAnchor(lines, anchor, radius) : null;
  if (!window) return null;
  const key = anchor.side === "LEFT" ? "leftLine" : "rightLine";
  return window.map((line) => {
    const number = line[key];
    return {
      kind: line.kind,
      text: line.text,
      left_line: line.leftLine,
      right_line: line.rightLine,
      anchored:
        number != null &&
        number >= anchor.startLine &&
        number <= anchor.endLine,
    };
  });
}

function contentLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function pathsForFile(file: DiffFile): Set<string> {
  return new Set(
    [file.filename, file.headFilename, file.previousFilename].filter(
      (path): path is string => path != null,
    ),
  );
}

function currentFileForAnchor(
  files: DiffFile[],
  thread: S.DiffFeedbackThreadRow,
): DiffFile | null {
  const originalPaths = new Set(
    [thread.path, thread.original_path].filter(
      (path): path is string => path != null,
    ),
  );
  return (
    files.find((file) =>
      [...pathsForFile(file)].some((path) => originalPaths.has(path)),
    ) ?? null
  );
}

function pathAtSide(
  file: Pick<DiffFile, "filename" | "headFilename" | "previousFilename">,
  side: DiffSide,
): string {
  return side === "LEFT"
    ? (file.previousFilename ?? file.filename)
    : (file.headFilename ?? file.filename);
}

interface ResolvedThreadLocation {
  freshness: DiffFeedbackFreshness;
  reason: DiffFeedbackOutdatedReason | null;
  placement: DiffFeedbackPlacement;
  anchor: {
    path: string;
    original_path: string | null;
    side: DiffSide;
    start_line: number;
    end_line: number;
  } | null;
  lines: DiffLine[] | null;
}

function placementFor(
  lines: DiffLine[] | null,
  anchor: { side: DiffSide; startLine: number; endLine: number },
): DiffFeedbackPlacement {
  return lines && linesForAnchor(lines, anchor) ? "inline" : "historical";
}

async function resolveCurrentLocation(
  repoPath: string,
  pair: { baseSha: string; headSha: string } | null,
  files: DiffFile[],
  thread: S.DiffFeedbackThreadRow,
  originalLines: DiffLine[] | null,
): Promise<ResolvedThreadLocation> {
  const side = thread.side as DiffSide;
  const originalAnchor = anchorOf(thread);
  if (!pair) {
    return {
      freshness: "unavailable",
      reason: null,
      placement: "historical",
      anchor: null,
      lines: null,
    };
  }
  if (pair.baseSha === thread.base_sha && pair.headSha === thread.head_sha) {
    return {
      freshness: "current",
      reason: null,
      placement: placementFor(originalLines, originalAnchor),
      anchor: {
        path: thread.path,
        original_path: thread.original_path,
        side,
        start_line: thread.start_line,
        end_line: thread.end_line,
      },
      lines: originalLines,
    };
  }

  const currentFile = currentFileForAnchor(files, thread);
  if (!currentFile) {
    return {
      freshness: "outdated",
      reason: "deleted",
      placement: "historical",
      anchor: null,
      lines: null,
    };
  }
  const currentLines = parsePatchWithCoordinates(currentFile.patch);
  const originalPlacement = placementFor(currentLines, originalAnchor);

  const originalRef = side === "LEFT" ? thread.base_sha : thread.head_sha;
  const currentRef = side === "LEFT" ? pair.baseSha : pair.headSha;
  const originalPath =
    side === "LEFT" ? (thread.original_path ?? thread.path) : thread.path;
  const currentPath = pathAtSide(currentFile, side);
  const [originalFile, currentFileContent] = await Promise.all([
    fileAtRef(repoPath, originalRef, originalPath),
    fileAtRef(repoPath, currentRef, currentPath),
  ]);
  if (originalFile.status !== "ok") {
    return {
      freshness: "unavailable",
      reason: null,
      placement: originalPlacement,
      anchor: null,
      lines: null,
    };
  }
  if (currentFileContent.status === "missing") {
    return {
      freshness: "outdated",
      reason: "deleted",
      placement: originalPlacement,
      anchor: null,
      lines: null,
    };
  }
  if (currentFileContent.status !== "ok") {
    return {
      freshness: "unavailable",
      reason: null,
      placement: originalPlacement,
      anchor: null,
      lines: null,
    };
  }

  const resolution = resolveDiffFeedbackRange(
    contentLines(originalFile.content!),
    contentLines(currentFileContent.content!),
    thread.start_line,
    thread.end_line,
  );
  if (resolution.status === "outdated") {
    return {
      freshness: "outdated",
      reason: resolution.reason,
      placement: originalPlacement,
      anchor: null,
      lines: null,
    };
  }

  const resolvedAnchor = {
    side,
    startLine: resolution.startLine,
    endLine: resolution.endLine,
  };
  if (!linesForAnchor(currentLines, resolvedAnchor)) {
    return {
      freshness: "outdated",
      reason: "modified",
      placement: originalPlacement,
      anchor: null,
      lines: null,
    };
  }
  return {
    freshness: "current",
    reason: null,
    placement: "inline",
    anchor: {
      path: currentFile.headFilename ?? currentFile.filename,
      original_path: currentFile.previousFilename ?? null,
      side,
      start_line: resolution.startLine,
      end_line: resolution.endLine,
    },
    lines: currentLines,
  };
}

// The wire thread plus the patch it was resolved against, so a caller that also wants diff context
// does not read the same patch a second time.
async function resolveThread(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
  actor?: string,
): Promise<{
  wire: DiffFeedbackThreadWire;
  lines: DiffLine[] | null;
  anchor: { side: DiffSide; startLine: number; endLine: number };
}> {
  const pair = await currentPair(repoPath, pull);
  const [files, distinctOriginalFiles] = await Promise.all([
    pair ? diffFilesBetween(repoPath, pair.baseSha, pair.headSha) : [],
    pair?.baseSha === thread.base_sha && pair.headSha === thread.head_sha
      ? Promise.resolve(null)
      : diffFilesBetween(repoPath, thread.base_sha, thread.head_sha),
  ]);
  const originalLines = anchorLines(distinctOriginalFiles ?? files, thread);
  const originalAnchor = anchorOf(thread);
  const available = Boolean(
    originalLines && linesForAnchor(originalLines, originalAnchor),
  );
  const location = available
    ? await resolveCurrentLocation(repoPath, pair, files, thread, originalLines)
    : {
        freshness: "unavailable" as const,
        reason: null,
        placement: "historical" as const,
        anchor: null,
        lines: null,
      };
  const wire = threadWire(
    thread,
    location,
    contextJSON(originalLines, originalAnchor, DEFAULT_CONTEXT_RADIUS),
    actor,
  );
  const resolvedAnchor = location.anchor
    ? {
        side: location.anchor.side,
        startLine: location.anchor.start_line,
        endLine: location.anchor.end_line,
      }
    : originalAnchor;
  return {
    wire,
    lines: location.lines ?? originalLines,
    anchor: resolvedAnchor,
  };
}

function threadWire(
  thread: S.DiffFeedbackThreadRow,
  location: ResolvedThreadLocation,
  originalContext: DiffFeedbackContextLineWire[] | null,
  actor?: string,
): DiffFeedbackThreadWire {
  return {
    id: thread.id,
    pr_number: thread.pr_number,
    anchor: {
      base_sha: thread.base_sha,
      head_sha: thread.head_sha,
      path: thread.path,
      original_path: thread.original_path,
      side: thread.side as DiffSide,
      start_line: thread.start_line,
      end_line: thread.end_line,
    },
    resolved_anchor: location.anchor,
    freshness: location.freshness,
    outdated_reason: location.reason,
    placement: location.placement,
    original_context: originalContext,
    archived_at: thread.archived_at,
    created_by: thread.created_by,
    created_by_type: thread.created_by_type,
    created_at: thread.created_at,
    messages: S.listDiffFeedbackMessages(thread.id).map((message) =>
      diffFeedbackMessageJSON(
        message,
        S.listDiffFeedbackReactions(message.id),
        actor,
      ),
    ),
  };
}

function parseLocation(row: S.DiffFeedbackLocationRow): {
  location: ResolvedThreadLocation;
  originalContext: DiffFeedbackContextLineWire[] | null;
} {
  const invalid = (field: string): never => {
    throw new Error(
      `invalid diff feedback location for thread ${row.thread_id} at ${row.base_sha}..${row.head_sha}: ${field}`,
    );
  };
  const parseJSON = (value: string, field: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return invalid(field);
    }
  };
  const freshness = ["current", "outdated", "unavailable"].includes(
    row.freshness,
  )
    ? (row.freshness as DiffFeedbackFreshness)
    : invalid("freshness");
  const reason =
    row.outdated_reason == null ||
    ["deleted", "modified", "ambiguous"].includes(row.outdated_reason)
      ? (row.outdated_reason as DiffFeedbackOutdatedReason | null)
      : invalid("outdated_reason");
  const placement = ["inline", "historical"].includes(row.placement)
    ? (row.placement as DiffFeedbackPlacement)
    : invalid("placement");
  const anchor = row.resolved_anchor_json
    ? parseJSON(row.resolved_anchor_json, "resolved_anchor_json")
    : null;
  if (
    anchor != null &&
    (typeof anchor !== "object" ||
      !("path" in anchor) ||
      typeof anchor.path !== "string" ||
      !("original_path" in anchor) ||
      (anchor.original_path !== null &&
        typeof anchor.original_path !== "string") ||
      !("side" in anchor) ||
      (anchor.side !== "LEFT" && anchor.side !== "RIGHT") ||
      !("start_line" in anchor) ||
      typeof anchor.start_line !== "number" ||
      !Number.isInteger(anchor.start_line) ||
      !("end_line" in anchor) ||
      typeof anchor.end_line !== "number" ||
      !Number.isInteger(anchor.end_line) ||
      anchor.start_line < 1 ||
      anchor.end_line < anchor.start_line)
  ) {
    invalid("resolved_anchor_json");
  }
  if (
    (freshness === "current" && (reason !== null || anchor === null)) ||
    (freshness === "outdated" && (reason === null || anchor !== null)) ||
    (freshness === "unavailable" && (reason !== null || anchor !== null))
  ) {
    invalid("location union");
  }
  const originalContext = row.original_context_json
    ? parseJSON(row.original_context_json, "original_context_json")
    : null;
  if (
    originalContext != null &&
    (!Array.isArray(originalContext) ||
      originalContext.some(
        (line) =>
          typeof line !== "object" ||
          line == null ||
          !["hunk", "context", "addition", "deletion", "meta"].includes(
            line.kind,
          ) ||
          typeof line.text !== "string" ||
          (line.left_line !== null && !Number.isInteger(line.left_line)) ||
          (line.right_line !== null && !Number.isInteger(line.right_line)) ||
          typeof line.anchored !== "boolean",
      ))
  ) {
    invalid("original_context_json");
  }
  return {
    location: {
      anchor: anchor as ResolvedThreadLocation["anchor"],
      freshness,
      reason,
      placement,
      lines: null,
    },
    originalContext: originalContext as DiffFeedbackContextLineWire[] | null,
  };
}

function fallbackLocation(
  files: DiffFile[],
  thread: S.DiffFeedbackThreadRow,
): ResolvedThreadLocation {
  const file = currentFileForAnchor(files, thread);
  const lines = file ? parsePatchWithCoordinates(file.patch) : null;
  return {
    anchor: null,
    freshness: "unavailable",
    reason: null,
    placement: placementFor(lines, anchorOf(thread)),
    lines: null,
  };
}

async function precomputeLocations(
  repoPath: string,
  pull: S.PullRow,
  threads: S.DiffFeedbackThreadRow[],
): Promise<number> {
  if (threads.length === 0) return 0;
  const pair = await currentPair(repoPath, pull);
  if (!pair) return 0;
  const storedThreadIds = new Set(
    S.listDiffFeedbackLocations(pull.issue_id, pair.baseSha, pair.headSha).map(
      ({ thread_id }) => thread_id,
    ),
  );
  const missingThreads = threads.filter(
    (thread) => !storedThreadIds.has(thread.id),
  );
  if (missingThreads.length === 0) return 0;
  const pairKey = `${pair.baseSha}:${pair.headSha}`;
  const filesByPair = new Map<string, Promise<DiffFile[]>>();
  filesByPair.set(
    pairKey,
    diffFilesBetween(repoPath, pair.baseSha, pair.headSha),
  );
  const files = await filesByPair.get(pairKey)!;

  // Resolve every location against git first, then write the whole cache in one transaction: the
  // anchor resolution reads the diff, which must not happen while the writer lock is held.
  const resolved = await Promise.all(
    missingThreads.map(async (thread) => {
      const originalKey = `${thread.base_sha}:${thread.head_sha}`;
      let originalFiles = filesByPair.get(originalKey);
      if (!originalFiles) {
        originalFiles = diffFilesBetween(
          repoPath,
          thread.base_sha,
          thread.head_sha,
        );
        filesByPair.set(originalKey, originalFiles);
      }
      const originalLines = anchorLines(await originalFiles, thread);
      const originalAnchor = anchorOf(thread);
      const location =
        originalLines && linesForAnchor(originalLines, originalAnchor)
          ? await resolveCurrentLocation(
              repoPath,
              pair,
              files,
              thread,
              originalLines,
            )
          : {
              freshness: "unavailable" as const,
              reason: null,
              placement: "historical" as const,
              anchor: null,
              lines: null,
            };
      const originalContext = contextJSON(
        originalLines,
        originalAnchor,
        DEFAULT_CONTEXT_RADIUS,
      );
      return {
        thread_id: thread.id,
        base_sha: pair.baseSha,
        head_sha: pair.headSha,
        resolved_anchor_json: location.anchor
          ? JSON.stringify(location.anchor)
          : null,
        freshness: location.freshness,
        outdated_reason: location.reason,
        placement: location.placement,
        original_context_json: originalContext
          ? JSON.stringify(originalContext)
          : null,
      };
    }),
  );
  db.transaction(() => {
    for (const row of resolved) S.upsertDiffFeedbackLocation(row);
  });
  return missingThreads.length;
}

function cachedThreadDetail(
  thread: S.DiffFeedbackThreadRow,
  cached: S.DiffFeedbackLocationRow,
  files: DiffFile[],
  contextRadius: number,
): DiffFeedbackThreadDetailWire | null {
  const parsed = parseLocation(cached);
  if (contextRadius !== DEFAULT_CONTEXT_RADIUS) return null;
  const anchor = parsed.location.anchor;
  let context = parsed.originalContext;
  const anchorMatchesOriginal =
    cached.base_sha === thread.base_sha &&
    cached.head_sha === thread.head_sha &&
    anchor?.path === thread.path &&
    anchor.original_path === thread.original_path &&
    anchor.side === thread.side &&
    anchor.start_line === thread.start_line &&
    anchor.end_line === thread.end_line;
  if (anchor && !anchorMatchesOriginal) {
    const file = fileForAnchor(files, {
      base_sha: cached.base_sha,
      head_sha: cached.head_sha,
      path: anchor.path,
      side: anchor.side,
    });
    const lines = file ? parsePatchWithCoordinates(file.patch) : null;
    context = contextJSON(
      lines,
      {
        side: anchor.side,
        startLine: anchor.start_line,
        endLine: anchor.end_line,
      },
      contextRadius,
    );
  }
  return {
    ...threadWire(thread, parsed.location, parsed.originalContext),
    context,
  };
}

async function threadJSON(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
  actor?: string,
): Promise<DiffFeedbackThreadWire> {
  return (await resolveThread(repoPath, pull, thread, actor)).wire;
}

async function threadDetailJSON(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
  radius: number,
): Promise<DiffFeedbackThreadDetailWire> {
  const { wire, lines, anchor } = await resolveThread(repoPath, pull, thread);
  return { ...wire, context: contextJSON(lines, anchor, radius) };
}

// What the anchor of a diff feedback event points at, so an events reader knows which lines a
// comment is about without loading the thread first (#2045). The anchor is fixed when the thread is
// created, so this copy cannot drift. The comment body is deliberately not here: an event is the
// trigger, not the record, and the thread and comment ids name the canonical rows. The commenter is
// the event's own `actor`.
function anchorPayload(thread: S.DiffFeedbackThreadRow) {
  return {
    path: thread.path,
    side: thread.side,
    start_line: thread.start_line,
    end_line: thread.end_line,
  };
}

function threadForPull(
  issueId: number,
  threadId: number,
): S.DiffFeedbackThreadRow {
  const thread = S.getDiffFeedbackThread(threadId);
  if (!thread || thread.issue_id !== issueId)
    throw new ServiceError(404, "diff feedback thread not found");
  return thread;
}

export const diffFeedback = {
  async list(
    name: string,
    number: number,
    scope: { path?: string; orphaned?: boolean } = {},
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    const pair = await currentPair(r.local_path, pull);
    const files = pair
      ? await diffFilesBetween(r.local_path, pair.baseSha, pair.headSha)
      : [];
    const stored = pair
      ? new Map(
          S.listDiffFeedbackLocations(row.id, pair.baseSha, pair.headSha).map(
            (location) => [location.thread_id, location],
          ),
        )
      : new Map<number, S.DiffFeedbackLocationRow>();
    const threads = S.listDiffFeedbackThreads(row.id).map((thread) => {
      const cached = stored.get(thread.id);
      const parsed = cached ? parseLocation(cached) : null;
      return threadWire(
        thread,
        parsed?.location ?? fallbackLocation(files, thread),
        parsed?.originalContext ?? null,
        actorFor(sessionId),
      );
    });
    return {
      threads: selectDiffFeedbackThreads(threads, files, scope),
      comment_counts: countDiffFeedbackMessagesByFile(threads, files),
    };
  },

  async precompute(name: string, number: number): Promise<number> {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return precomputeLocations(
      r.local_path,
      S.getPull(row.id)!,
      S.listDiffFeedbackThreads(row.id),
    );
  },

  async get(
    name: string,
    number: number,
    threadId: number,
    contextRadius: number = DEFAULT_CONTEXT_RADIUS,
  ): Promise<DiffFeedbackThreadDetailWire> {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return threadDetailJSON(
      r.local_path,
      S.getPull(row.id)!,
      threadForPull(row.id, threadId),
      contextRadius,
    );
  },

  /**
   * The threads on this PR the given workflow run has not answered yet, with the diff context of
   * each anchor (#2045). This is what an Execute child reads after the parent hands it a diff
   * comment: the run — not the individual child session — is the responding party, so a thread a
   * previous turn already replied to stays out of the list.
   */
  async pending(
    name: string,
    number: number,
    runId: number,
    contextRadius: number = DEFAULT_CONTEXT_RADIUS,
  ): Promise<DiffFeedbackPendingWire> {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    const run = S.getWorkflowRun(runId);
    if (!run || run.repo_id !== r.id || run.pr_number !== number) {
      throw new ServiceError(
        404,
        `workflow run #${runId} not found for pull request #${number}`,
      );
    }
    const responders = new Set(
      [
        ...workflowStepSessionIds(run.step_sessions_json, "execute"),
        ...workflowStepSessionIds(run.step_sessions_json, "verify"),
      ]
        .map((sessionId) => S.authorFromSession(sessionId))
        .filter((author): author is string => author !== null),
    );
    const unanswered = S.listUnansweredDiffFeedbackThreads(row.id, [
      ...responders,
    ]);
    if (unanswered.length === 0) {
      return { run: run.id, threads: [] };
    }
    const pair = await currentPair(r.local_path, pull);
    const stored = pair
      ? new Map(
          S.listDiffFeedbackLocations(row.id, pair.baseSha, pair.headSha).map(
            (location) => [location.thread_id, location],
          ),
        )
      : new Map<number, S.DiffFeedbackLocationRow>();
    const needsCurrentDiff =
      contextRadius === DEFAULT_CONTEXT_RADIUS &&
      unanswered.some((thread) => {
        const cached = stored.get(thread.id);
        const anchor = cached ? parseLocation(cached).location.anchor : null;
        return (
          anchor != null &&
          (cached!.base_sha !== thread.base_sha ||
            cached!.head_sha !== thread.head_sha ||
            anchor.path !== thread.path ||
            anchor.original_path !== thread.original_path ||
            anchor.side !== thread.side ||
            anchor.start_line !== thread.start_line ||
            anchor.end_line !== thread.end_line)
        );
      });
    const files =
      pair && needsCurrentDiff
        ? await diffFilesBetween(r.local_path, pair.baseSha, pair.headSha)
        : [];
    const threads = await Promise.all(
      unanswered.map((thread) => {
        const cached = stored.get(thread.id);
        return (
          (cached
            ? cachedThreadDetail(thread, cached, files, contextRadius)
            : null) ??
          threadDetailJSON(r.local_path, pull, thread, contextRadius)
        );
      }),
    );
    return {
      run: run.id,
      threads,
    };
  },

  async create(
    name: string,
    number: number,
    input: {
      baseSha: string;
      headSha: string;
      path: string;
      side: string;
      startLine: number;
      endLine: number;
      body: string;
    },
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    if (!FULL_SHA.test(input.baseSha) || !FULL_SHA.test(input.headSha))
      throw new ServiceError(
        422,
        "base-sha and head-sha must be full commit SHAs",
      );
    if (input.side !== "LEFT" && input.side !== "RIGHT")
      throw new ServiceError(422, "side must be LEFT or RIGHT");
    if (!input.path || !input.body)
      throw new ServiceError(422, "path and body are required");
    const pair = await currentPair(r.local_path, pull);
    if (
      !pair ||
      pair.baseSha !== input.baseSha ||
      pair.headSha !== input.headSha
    )
      throw new ServiceError(409, "pull request diff has changed");
    const files = await diffFilesBetween(
      r.local_path,
      input.baseSha,
      input.headSha,
    );
    const file = fileForAnchor(files, {
      base_sha: input.baseSha,
      head_sha: input.headSha,
      path: input.path,
      side: input.side,
    });
    const lines = file ? parsePatchWithCoordinates(file.patch) : null;
    if (
      !file ||
      !lines ||
      !linesForAnchor(lines, {
        side: input.side,
        startLine: input.startLine,
        endLine: input.endLine,
      })
    )
      throw new ServiceError(
        422,
        "anchor does not resolve to selectable diff lines",
      );
    const { actor, authorType } = commentActor(sessionId);
    const path = file.headFilename ?? file.filename;
    const originalPath = file.previousFilename ?? null;
    // The anchor is resolved from the diff above; only the thread, its first message and the event
    // are transactional.
    const { thread, comment } = db.transaction(() => {
      const created = S.createDiffFeedbackThread({
        issueId: row.id,
        prNumber: number,
        baseSha: input.baseSha,
        headSha: input.headSha,
        path,
        originalPath,
        side: input.side,
        startLine: input.startLine,
        endLine: input.endLine,
        actor,
        authorType,
      });
      const resolvedAnchor = {
        path: created.path,
        original_path: created.original_path,
        side: created.side as DiffSide,
        start_line: created.start_line,
        end_line: created.end_line,
      };
      S.upsertDiffFeedbackLocation({
        thread_id: created.id,
        base_sha: input.baseSha,
        head_sha: input.headSha,
        resolved_anchor_json: JSON.stringify(resolvedAnchor),
        freshness: "current",
        outdated_reason: null,
        placement: "inline",
        original_context_json: JSON.stringify(
          contextJSON(lines, anchorOf(created), DEFAULT_CONTEXT_RADIUS),
        ),
      });
      const message = S.createDiffFeedbackMessage(
        created.id,
        actor,
        input.body,
        authorType,
      );
      // `session_id` travels so a Workflow run can tell a comment written by one of its own
      // children from one it has to hand to Execute. The comment itself stays canonical in the DB,
      // which Execute reads back with `lh pr feedback`.
      S.emitEvent(r.id, "pull_request.diff_feedback_created", actor, {
        number,
        thread_id: created.id,
        comment_id: message.id,
        session_id: sessionId ?? null,
        source_payload_version: SOURCE_PAYLOAD_VERSION,
        ...anchorPayload(created),
      });
      maybeNotifyAgentComment({
        repoId: r.id,
        pullNumber: number,
        commentId: message.id,
        authorType,
        actor,
        body: input.body,
        source: "diff",
      });
      return { thread: created, comment: message };
    });
    return {
      thread: await threadJSON(r.local_path, pull, thread),
      comment: diffFeedbackMessageJSON(comment),
    };
  },

  async reply(
    name: string,
    number: number,
    threadId: number,
    body: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    const thread = threadForPull(row.id, threadId);
    if (!body) throw new ServiceError(422, "body is required");
    const { actor, authorType } = commentActor(sessionId);
    const reply = db.transaction(() => {
      const message = S.createDiffFeedbackMessage(
        thread.id,
        actor,
        body,
        authorType,
      );
      S.emitEvent(r.id, "pull_request.diff_feedback_replied", actor, {
        number,
        thread_id: thread.id,
        reply_message_id: message.id,
        session_id: sessionId ?? null,
        source_payload_version: SOURCE_PAYLOAD_VERSION,
        ...anchorPayload(thread),
      });
      maybeNotifyAgentComment({
        repoId: r.id,
        pullNumber: number,
        commentId: message.id,
        authorType,
        actor,
        body,
        source: "diff",
      });
      return message;
    });
    return {
      thread: await threadJSON(r.local_path, pull, thread),
      reply: diffFeedbackMessageJSON(reply),
    };
  },

  /**
   * Archive or unarchive a conversation. An archived thread is kept and still rendered — collapsed —
   * so the exchange stays readable; it only drops out of the pending feedback an Execute child reads.
   */
  async archive(
    name: string,
    number: number,
    threadId: number,
    archived: boolean,
  ): Promise<DiffFeedbackThreadWire> {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    const thread = threadForPull(row.id, threadId);
    const updated = S.setDiffFeedbackThreadArchived(thread.id, archived);
    return threadJSON(r.local_path, pull, updated);
  },

  async react(
    name: string,
    number: number,
    messageId: number,
    emoji: string,
    sessionId?: string | null,
  ) {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    const message = S.getDiffFeedbackMessage(messageId);
    if (!message)
      throw new ServiceError(404, "diff feedback message not found");
    threadForPull(row.id, message.thread_id);
    if (!(DIFF_FEEDBACK_REACTIONS as readonly string[]).includes(emoji)) {
      throw new ServiceError(422, "unsupported diff feedback reaction");
    }
    const actor = actorFor(sessionId);
    // The reaction toggle reads the current row before writing, so the write and the read that
    // renders it belong to one transaction.
    return db.transaction(() => {
      S.setDiffFeedbackReaction(message.id, actor, emoji);
      return diffFeedbackMessageJSON(
        message,
        S.listDiffFeedbackReactions(message.id),
        actor,
      );
    });
  },
};
