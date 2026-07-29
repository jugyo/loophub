import {
  type DiffSide,
  linesForAnchor,
  parsePatchWithCoordinates,
} from "../diff-anchor.ts";
import {
  countDiffFeedbackMessagesByFile,
  selectDiffFeedbackThreads,
} from "../diff-feedback-selection.ts";
import { ServiceError } from "../errors.ts";
import { diffFilesBetween, revParse } from "../git.ts";
import { resolvePullBaseSha } from "../pull-base.ts";
import {
  type DiffFeedbackFreshness,
  type DiffFeedbackThreadWire,
  diffFeedbackMessageJSON,
} from "../serialize.ts";
import * as S from "../store.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

const FULL_SHA = /^[0-9a-f]{40}$/i;

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

async function anchorAvailable(
  repoPath: string,
  thread: S.DiffFeedbackThreadRow,
): Promise<boolean> {
  const file = await fileForAnchor(repoPath, thread);
  if (!file) return false;
  return Boolean(
    linesForAnchor(parsePatchWithCoordinates(file.patch), {
      side: thread.side as DiffSide,
      startLine: thread.start_line,
      endLine: thread.end_line,
    }),
  );
}

async function threadJSON(
  repoPath: string,
  pull: S.PullRow,
  thread: S.DiffFeedbackThreadRow,
): Promise<DiffFeedbackThreadWire> {
  const pair = await currentPair(repoPath, pull);
  const available = await anchorAvailable(repoPath, thread);
  const freshness: DiffFeedbackFreshness = !available
    ? "unavailable"
    : pair?.baseSha === thread.base_sha && pair.headSha === thread.head_sha
      ? "current"
      : "outdated";
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
    freshness,
    created_by: thread.created_by,
    created_at: thread.created_at,
    messages: S.listDiffFeedbackMessages(thread.id).map(
      diffFeedbackMessageJSON,
    ),
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

  async get(name: string, number: number, threadId: number) {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return threadJSON(
      r.local_path,
      S.getPull(row.id)!,
      threadForPull(row.id, threadId),
    );
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
    S.emitEvent(r.id, "pull_request.diff_feedback_created", actor, {
      number,
      thread_id: thread.id,
      comment_id: comment.id,
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
    S.emitEvent(r.id, "pull_request.diff_feedback_replied", actor, {
      number,
      thread_id: thread.id,
      reply_message_id: reply.id,
    });
    return {
      thread: await threadJSON(r.local_path, pull, thread),
      reply: diffFeedbackMessageJSON(reply),
    };
  },
};
