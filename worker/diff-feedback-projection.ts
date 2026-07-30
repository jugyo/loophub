import { diffFeedback, repos } from "../core/service.ts";

const FULL_SHA = /^[0-9a-f]{40}$/i;

interface ProjectionEvent {
  id: number;
  repo_id: number | null;
  type: string;
  payload: string;
}

function projectionTarget(
  row: Pick<ProjectionEvent, "type" | "payload">,
): number | null {
  try {
    const parsed = JSON.parse(row.payload);
    if (typeof parsed?.number !== "number") return null;
    if (row.type === "pull_request.diff_feedback_created") return parsed.number;
    return typeof parsed.sha === "string" && FULL_SHA.test(parsed.sha)
      ? parsed.number
      : null;
  } catch {
    return null;
  }
}

export async function projectDiffFeedbackEvent(
  row: ProjectionEvent,
): Promise<void> {
  if (
    row.repo_id == null ||
    (row.type !== "pull_request.updated" &&
      row.type !== "pull_request.diff_feedback_created")
  ) {
    return;
  }
  const repo = repos.getById(row.repo_id);
  const number = projectionTarget(row);
  if (!repo || number == null) return;

  try {
    await diffFeedback.precompute(repo.full_name, number);
  } catch (error) {
    console.error(
      `lh-worker: diff feedback projection error event_id=${row.id} event_type=${row.type} repo=${repo.full_name} pr=${number}:`,
      error,
    );
  }
}

export function scheduleDiffFeedbackProjection(row: ProjectionEvent): void {
  void projectDiffFeedbackEvent(row);
}
