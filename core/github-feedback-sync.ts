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

// Poll feedback only for active Workflow PRs. A PR is the failure boundary: auth/network/parse
// failure is reported for that PR and the next candidate still runs. New/edited items are persisted
// before one aggregate event is emitted, so subsequent ticks and worker restarts remain quiet.
export async function syncGithubFeedback(
  deps: GithubFeedbackDeps = realGithubFeedbackDeps,
): Promise<GithubFeedbackSyncResult> {
  const result: GithubFeedbackSyncResult = {
    checked: 0,
    emitted: [],
    failures: [],
  };
  for (const link of S.activeWorkflowGithubPullLinks()) {
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
        for (const item of feedback) {
          const hash = contentHash(item.body);
          const previous = S.getGithubFeedbackObservation(
            link.issue_id,
            item.kind,
            item.id,
          );
          if (previous?.content_hash === hash) continue;
          S.saveGithubFeedbackObservation({
            issueId: link.issue_id,
            kind: item.kind,
            githubId: item.id,
            contentHash: hash,
            updatedAt: item.updatedAt,
          });
          changed.push({
            kind: item.kind,
            id: item.id,
            updated_at: item.updatedAt,
            reference: feedbackReference(link.url, item),
          });
        }
        if (changed.length === 0) return [];
        return [
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
        ];
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
