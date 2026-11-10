import { createHash } from "node:crypto";
import { db } from "./db.ts";
import {
  type GithubFeedbackDeps,
  type GithubPrFeedback,
  parseGithubPullUrl,
  realGithubFeedbackDeps,
} from "./github.ts";
import * as S from "./store.ts";
import { SOURCE_PAYLOAD_VERSION } from "./workflow/source-events.ts";

export type { GithubPrFeedback } from "./github.ts";

export interface GithubFeedbackFailure {
  number: number;
  github_number: number;
  error: string;
}

export interface GithubFeedbackSyncResult {
  checked: number;
  emitted: S.EventRow[];
  failures: GithubFeedbackFailure[];
}

function contentHash(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function feedbackReference(url: string, feedback: GithubPrFeedback): string {
  const ref = parseGithubPullUrl(url);
  if (!ref) throw new Error(`invalid GitHub PR URL: ${url}`);
  if (feedback.kind === "issue_comment") {
    return `repos/${ref.owner}/${ref.repo}/issues/comments/${feedback.id}`;
  }
  if (feedback.kind === "review") {
    return `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews/${feedback.id}`;
  }
  return `repos/${ref.owner}/${ref.repo}/pulls/comments/${feedback.id}`;
}

// #2500: where the PR timeline sends a reader for this item. Built from the same parsed coordinates
// as feedbackReference — GitHub's own `html_url` is never read, so an API response cannot decide
// where a LoopHub link points.
function feedbackPermalink(url: string, feedback: GithubPrFeedback): string {
  const ref = parseGithubPullUrl(url);
  if (!ref) throw new Error(`invalid GitHub PR URL: ${url}`);
  const pull = `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`;
  if (feedback.kind === "issue_comment")
    return `${pull}#issuecomment-${feedback.id}`;
  if (feedback.kind === "review")
    return `${pull}#pullrequestreview-${feedback.id}`;
  return `${pull}#discussion_r${feedback.id}`;
}

function displayChanged(
  previous: S.GithubFeedbackObservation | null,
  next: Omit<S.GithubFeedbackObservation, "observed_at" | "notified_hash">,
): boolean {
  if (!previous) return true;
  return (Object.keys(next) as Array<keyof typeof next>).some(
    (key) => previous[key] !== next[key],
  );
}

// Poll every open linked PR. A PR is the failure boundary: auth/network/parse failure is reported
// for that PR and the next candidate still runs. Items are persisted before the events are emitted,
// so subsequent ticks and worker restarts remain quiet. `pull_request.github_feedback` wakes the
// PR's agent, so only an active Workflow run gets it; `pull_request.github_data_updated` only
// refreshes an open screen and carries no GitHub text.
export async function syncGithubFeedback(
  deps: GithubFeedbackDeps = realGithubFeedbackDeps,
): Promise<GithubFeedbackSyncResult> {
  const result: GithubFeedbackSyncResult = {
    checked: 0,
    emitted: [],
    failures: [],
  };
  for (const link of S.githubFeedbackSyncRows()) {
    result.checked++;
    let feedback: GithubPrFeedback[];
    try {
      feedback = await deps.fetchFeedback(link.local_path, link.url);
      // Validate the recorded URL before writing observations. The same parsed coordinates are used
      // to construct all references; API-provided URLs never enter an event or notification.
      if (!parseGithubPullUrl(link.url)) {
        throw new Error(`invalid GitHub PR URL: ${link.url}`);
      }
    } catch (error) {
      result.failures.push({
        number: link.number,
        github_number: link.github_number,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    let emitted: S.EventRow[] = [];
    try {
      // The HTTP fetch above is already done; only the synchronous DB phase is transactional.
      emitted = db.transaction(() => {
        const changed: Array<{
          kind: GithubPrFeedback["kind"];
          id: number;
          updated_at: string;
          reference: string;
        }> = [];
        let updated = false;
        for (const item of feedback) {
          const hash = contentHash(item.body);
          const previous = S.getGithubFeedbackObservation(
            link.issue_id,
            item.kind,
            item.id,
          );
          const notify =
            link.workflow_run_id !== null && previous?.notified_hash !== hash;
          const display = {
            issue_id: link.issue_id,
            kind: item.kind,
            github_id: item.id,
            content_hash: hash,
            updated_at: item.updatedAt,
            created_at: item.createdAt || null,
            author_login: item.authorLogin,
            review_state: item.reviewState,
            url: feedbackPermalink(link.url, item),
            body: item.body,
            github_number: link.github_number,
            path: item.path,
            line: item.line,
            in_reply_to_id: item.inReplyToId,
            review_id: item.reviewId,
            thread_id: item.threadId,
            thread_resolved:
              item.threadResolved === null ? null : Number(item.threadResolved),
          };
          const changedDisplay = displayChanged(previous, display);
          updated ||= changedDisplay;
          if (!changedDisplay && !notify) continue;
          S.saveGithubFeedbackObservation({
            issueId: link.issue_id,
            kind: item.kind,
            githubId: item.id,
            contentHash: hash,
            updatedAt: item.updatedAt,
            createdAt: display.created_at,
            authorLogin: item.authorLogin,
            reviewState: item.reviewState,
            url: display.url,
            body: item.body,
            githubNumber: link.github_number,
            path: item.path,
            line: item.line,
            inReplyToId: item.inReplyToId,
            reviewId: item.reviewId,
            threadId: item.threadId,
            threadResolved: item.threadResolved,
            notifiedHash: notify ? hash : (previous?.notified_hash ?? null),
          });
          if (!notify) continue;
          changed.push({
            kind: item.kind,
            id: item.id,
            updated_at: item.updatedAt,
            reference: feedbackReference(link.url, item),
          });
        }
        // Only rows from this GitHub PR: a relinked PR's older rows are not in `feedback` either.
        const fetched = new Set(feedback.map((i) => `${i.kind}:${i.id}`));
        for (const row of S.githubFeedbackObservations(link.issue_id)) {
          if (row.github_number !== link.github_number) continue;
          if (fetched.has(`${row.kind}:${row.github_id}`)) continue;
          S.deleteGithubFeedbackObservation(row);
          updated = true;
        }
        const events: S.EventRow[] = [];
        if (updated) {
          events.push(
            S.emitEvent(
              link.repo_id,
              "pull_request.github_data_updated",
              "lh-worker",
              { number: link.number, github_number: link.github_number },
            ),
          );
        }
        if (changed.length === 0) return events;
        events.push(
          S.emitEvent(
            link.repo_id,
            "pull_request.github_feedback",
            "lh-worker",
            {
              number: link.number,
              workflow_run_id: link.workflow_run_id,
              parent_session_id: link.parent_session_id,
              github_number: link.github_number,
              github_url: link.url,
              feedback: changed,
              source_payload_version: SOURCE_PAYLOAD_VERSION,
            },
          ),
        );
        return events;
      });
    } catch (error) {
      result.failures.push({
        number: link.number,
        github_number: link.github_number,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    result.emitted.push(...emitted);
  }
  return result;
}
