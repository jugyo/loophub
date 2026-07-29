import {
  type DiffLine,
  type DiffSide,
  linesAroundAnchor,
  linesForAnchor,
  parsePatchWithCoordinates,
} from "../diff-anchor.ts";
import {
  countDiffFeedbackMessagesByFile,
  selectDiffFeedbackThreads,
  selectUnansweredDiffFeedbackThreads,
} from "../diff-feedback-selection.ts";
import { ServiceError } from "../errors.ts";
import { diffFilesBetween, revParse } from "../git.ts";
import { resolvePullBaseSha } from "../pull-base.ts";
import {
  type DiffFeedbackContextLineWire,
  type DiffFeedbackFreshness,
  type DiffFeedbackPendingWire,
  type DiffFeedbackThreadDetailWire,
  type DiffFeedbackThreadWire,
  diffFeedbackMessageJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { workflowStepSessionIds } from "../workflow/herdr-agents.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";
import { projectWorkflowRunDiffFeedback } from "./workflow-run-events.ts";

const FULL_SHA = /^[0-9a-f]{40}$/i;
export const DIFF_FEEDBACK_REACTIONS = ["👍", "❤️", "🎉", "🚀", "👀"] as const;

/** Diff lines shown around an anchor when a caller does not ask for a different window. */
const DEFAULT_CONTEXT_RADIUS = 3;

async function currentPair(
  repoPath: string,
  pull: S.PullRow,
): Promise<{ baseSha: string; headSha: string } | null> {
  const [baseSha, headSha] = await Promise.all([
    resolvePullBaseSha(repoPath, pull),
    revParse(repoPath, pull.head_ref),
  ]);
  return baseSha && headSha ? { baseSha, headSha } : null;
}

async function fileForAnchor(
  repoPath: string,
  thread: Pick<
    S.DiffFeedbackThreadRow,
    "base_sha" | "head_sha" | "path" | "side"
  >,
) {
  const files = await diffFilesBetween(
    repoPath,
    thread.base_sha,
    thread.head_sha,
  );
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

async function anchorLines(
  repoPath: string,
  thread: S.DiffFeedbackThreadRow,
): Promise<DiffLine[] | null> {
  const file = await fileForAnchor(repoPath, thread);
  if (!file) return null;
  return parsePatchWithCoordinates(file.patch);
}

function contextJSON(
  lines: DiffLine[] | null,
  thread: S.DiffFeedbackThreadRow,
  radius: number,
): DiffFeedbackContextLineWire[] | null {
  const anchor = anchorOf(thread);
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

// The wire thread plus the patch it was resolved against, so a caller that also wants diff context
// does not read the same patch a second time.
async function resolveThread(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
): Promise<{ wire: DiffFeedbackThreadWire; lines: DiffLine[] | null }> {
  const pair = await currentPair(repoPath, pull);
  const lines = await anchorLines(repoPath, thread);
  const available = Boolean(lines && linesForAnchor(lines, anchorOf(thread)));
  const freshness: DiffFeedbackFreshness = !available
    ? "unavailable"
    : pair?.baseSha === thread.base_sha && pair.headSha === thread.head_sha
      ? "current"
      : "outdated";
  return {
    wire: {
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
      freshness,
      created_by: thread.created_by,
      created_at: thread.created_at,
      messages: S.listDiffFeedbackMessages(thread.id).map((message) =>
        diffFeedbackMessageJSON(
          message,
          S.listDiffFeedbackReactions(message.id),
        ),
      ),
    },
    lines,
  };
}

async function threadJSON(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
): Promise<DiffFeedbackThreadWire> {
  return (await resolveThread(repoPath, pull, thread)).wire;
}

async function threadDetailJSON(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
  radius: number,
): Promise<DiffFeedbackThreadDetailWire> {
  const { wire, lines } = await resolveThread(repoPath, pull, thread);
  return { ...wire, context: contextJSON(lines, thread, radius) };
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
  ) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    const pull = S.getPull(row.id)!;
    const pair = await currentPair(r.local_path, pull);
    const files = pair
      ? await diffFilesBetween(r.local_path, pair.baseSha, pair.headSha)
      : [];
    const threads = await Promise.all(
      S.listDiffFeedbackThreads(row.id).map((thread) =>
        threadJSON(r.local_path, pull, thread),
      ),
    );
    return {
      threads: selectDiffFeedbackThreads(threads, files, scope),
      comment_counts: countDiffFeedbackMessagesByFile(threads, files),
    };
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
    const threads = await Promise.all(
      S.listDiffFeedbackThreads(row.id).map((thread) =>
        threadDetailJSON(r.local_path, pull, thread, contextRadius),
      ),
    );
    return {
      run: run.id,
      threads: selectUnansweredDiffFeedbackThreads(threads, responders),
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
    const file = await fileForAnchor(r.local_path, {
      base_sha: input.baseSha,
      head_sha: input.headSha,
      path: input.path,
      side: input.side,
    });
    if (
      !file ||
      !linesForAnchor(parsePatchWithCoordinates(file.patch), {
        side: input.side,
        startLine: input.startLine,
        endLine: input.endLine,
      })
    )
      throw new ServiceError(
        422,
        "anchor does not resolve to selectable diff lines",
      );
    const actor = actorFor(sessionId);
    const path = file.headFilename ?? file.filename;
    const originalPath = file.previousFilename ?? null;
    const thread = S.createDiffFeedbackThread({
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
    });
    const comment = S.createDiffFeedbackMessage(thread.id, actor, input.body);
    const source = S.emitEvent(
      r.id,
      "pull_request.diff_feedback_created",
      actor,
      {
        number,
        thread_id: thread.id,
        comment_id: comment.id,
        ...anchorPayload(thread),
      },
    );
    projectWorkflowRunDiffFeedback({
      repoId: r.id,
      prNumber: number,
      actor,
      sessionId,
      source,
      threadId: thread.id,
      commentId: comment.id,
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
    const actor = actorFor(sessionId);
    const reply = S.createDiffFeedbackMessage(thread.id, actor, body);
    const source = S.emitEvent(
      r.id,
      "pull_request.diff_feedback_replied",
      actor,
      {
        number,
        thread_id: thread.id,
        reply_message_id: reply.id,
        ...anchorPayload(thread),
      },
    );
    projectWorkflowRunDiffFeedback({
      repoId: r.id,
      prNumber: number,
      actor,
      sessionId,
      source,
      threadId: thread.id,
      commentId: reply.id,
    });
    return {
      thread: await threadJSON(r.local_path, pull, thread),
      reply: diffFeedbackMessageJSON(reply),
    };
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
    S.createDiffFeedbackReaction(message.id, actorFor(sessionId), emoji);
    return diffFeedbackMessageJSON(
      message,
      S.listDiffFeedbackReactions(message.id),
    );
  },
};
