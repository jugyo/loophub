import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { sweepMergeReadyNotifications } from "../merge-ready-notifications.ts";
import { notificationJSON } from "../serialize.ts";
import * as S from "../store.ts";
import {
  actorFor,
  clampPerPage,
  ensureWritable,
  MAX_LIST_PER_PAGE,
  repoOr404,
} from "./shared.ts";

const MAX_NOTIFICATION_TITLE_LENGTH = 200;
const MAX_NOTIFICATION_BODY_LENGTH = 4096;

function notificationOr404(id: number): S.NotificationRow {
  const row = S.getNotificationById(id);
  if (!row) throw new ServiceError(404, "notification not found");
  return row;
}

function contentForSignal(signal: S.NotificationSignalRow): {
  title: string;
  body: string;
} {
  if (signal.reason === "cost_stopped") {
    return {
      title: "Over budget",
      body: `PR #${signal.number} was stopped after exceeding the configured budget.`,
    };
  }
  if (signal.reason === "github_merged") {
    return {
      title: `${signal.repo_full_name} PR #${signal.number} merged on GitHub`,
      body: `GitHub reports ${signal.repo_full_name} PR #${signal.number} as merged. Close the LoopHub PR manually to close it in LoopHub.`,
    };
  }
  if (signal.reason === "workflow_cost_exceeded") {
    return {
      title: "Workflow cost limit exceeded",
      body: `Workflow run #${signal.workflow_run_id} for ${signal.repo_full_name} Issue #${signal.issue_number} / PR #${signal.number} exceeded the configured cost limit: $${signal.cost_usd} > $${signal.limit_usd}.`,
    };
  }
  if (signal.reason === "workflow_rework_limit") {
    return {
      title: "Workflow rework limit reached",
      body: `Workflow run #${signal.workflow_run_id} for ${signal.repo_full_name} Issue #${signal.issue_number} / PR #${signal.number} reached the rework limit. ${signal.detail}`,
    };
  }
  throw new Error(`unsupported notification signal reason: ${signal.reason}`);
}

function assertKind(kind: unknown): S.NotificationKind {
  if (
    kind === "merge_ready" ||
    kind === "over_budget" ||
    kind === "human_attention"
  ) {
    return kind;
  }
  throw new ServiceError(
    422,
    "kind must be merge_ready, over_budget, or human_attention",
  );
}

function assertResourceKind(kind: unknown): S.NotificationResourceKind {
  if (kind === "issue" || kind === "pull" || kind === "repo") return kind;
  throw new ServiceError(422, "resource kind must be issue, pull, or repo");
}

function assertTitle(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ServiceError(422, "title is required");
  if (value.length > MAX_NOTIFICATION_TITLE_LENGTH) {
    throw new ServiceError(
      422,
      `title must be ${MAX_NOTIFICATION_TITLE_LENGTH} characters or fewer`,
    );
  }
  return value;
}

function assertBody(value: unknown): string {
  if (typeof value !== "string" || value === "")
    throw new ServiceError(422, "body is required");
  if (value.length > MAX_NOTIFICATION_BODY_LENGTH) {
    throw new ServiceError(
      422,
      `body must be ${MAX_NOTIFICATION_BODY_LENGTH} characters or fewer`,
    );
  }
  return value;
}

function assertResourceNumber(
  kind: S.NotificationResourceKind,
  value: unknown,
): number | null {
  if (kind === "repo") return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) {
    throw new ServiceError(
      422,
      `${kind} notification requires a positive resource number`,
    );
  }
  return number;
}

// The generated notifications and the cursor that says they were generated advance together: a
// cursor moved without its notifications would silently drop them.
function backfillFromSignals(): void {
  db.transaction(() => {
    const cursors = S.notificationSourceCursors();
    const highWatermarks = S.notificationSourceHighWatermarks();
    for (const signal of S.listNotificationSignalRows(
      cursors,
      highWatermarks,
    )) {
      const content = contentForSignal(signal);
      const row = S.createNotification({
        repoId: signal.repo_id,
        kind: signal.kind,
        severity: signal.severity,
        title: content.title,
        body: content.body,
        resourceKind: "pull",
        resourceNumber: signal.number,
        sourceKey: signal.source_key,
        createdAt: signal.created_at,
      });
      if (row) {
        S.emitEvent(row.repo_id, "notification.created", "loophub", {
          id: row.id,
          kind: row.kind,
          number: row.resource_number,
        });
      }
    }
    S.advanceNotificationSourceCursors(highWatermarks);
  });
}

async function refreshGeneratedNotifications(): Promise<void> {
  await sweepMergeReadyNotifications();
  backfillFromSignals();
}

export const notifications = {
  send(
    repoName: string,
    input: {
      kind: unknown;
      title: unknown;
      body: unknown;
      resourceKind?: unknown;
      resourceNumber?: unknown;
      sourceKey?: unknown;
      herdrPaneId?: unknown;
    },
    sessionId?: string | null,
  ): any {
    const repo = repoOr404(repoName);
    ensureWritable(repo);

    const kind = assertKind(input.kind);
    const resourceKind = assertResourceKind(input.resourceKind ?? "repo");
    const resourceNumber = assertResourceNumber(
      resourceKind,
      input.resourceNumber,
    );
    const sourceKeySuffix =
      typeof input.sourceKey === "string" && input.sourceKey.trim() !== ""
        ? input.sourceKey.trim()
        : `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const sourceKey = `cli:${repo.id}:${sourceKeySuffix}`;
    const herdrPaneId =
      typeof input.herdrPaneId === "string" && input.herdrPaneId.trim() !== ""
        ? input.herdrPaneId
        : null;
    return db.transaction(() => {
      const row = S.createNotification({
        repoId: repo.id,
        kind,
        title: assertTitle(input.title),
        body: assertBody(input.body),
        resourceKind,
        resourceNumber,
        sourceKey,
        herdrPaneId,
      });
      if (!row) throw new ServiceError(409, "notification already exists");
      S.emitEvent(row.repo_id, "notification.created", actorFor(sessionId), {
        id: row.id,
        kind: row.kind,
        number: row.resource_number,
      });
      return notificationJSON(row);
    });
  },

  async list(
    opts: { limit?: number; unreadOnly?: boolean } = {},
  ): Promise<any[]> {
    await refreshGeneratedNotifications();
    const limit = opts.unreadOnly
      ? undefined
      : clampPerPage(opts.limit, 50, MAX_LIST_PER_PAGE);
    return S.listNotifications({ limit, unreadOnly: opts.unreadOnly }).map(
      notificationJSON,
    );
  },

  async unreadCount(): Promise<{ count: number }> {
    await refreshGeneratedNotifications();
    return { count: S.unreadNotificationCount() };
  },

  read(id: number, sessionId?: string | null): any {
    const current = notificationOr404(id);
    const repo = S.getRepoById(current.repo_id);
    if (!repo) throw new ServiceError(404, "Not Found");

    return db.transaction(() => {
      const row = S.markNotificationRead(id) ?? notificationOr404(id);
      if (!current.read_at && row.read_at) {
        S.emitEvent(row.repo_id, "notification.updated", actorFor(sessionId), {
          id: row.id,
          read_at: row.read_at,
        });
      }
      return notificationJSON(row);
    });
  },

  async readAll(sessionId?: string | null): Promise<{ count: number }> {
    // The refresh above runs git/GitHub-derived readiness checks, so it stays outside; the mark-read
    // sweep and the events announcing it are transactional.
    await refreshGeneratedNotifications();
    const actor = actorFor(sessionId);
    return db.transaction(() => {
      const rows = S.markAllNotificationsRead();
      const repoIds = new Set(rows.map((row) => row.repo_id));
      for (const repoId of repoIds) {
        S.emitEvent(repoId, "notification.updated", actor, { read_all: true });
      }
      return { count: rows.length };
    });
  },

  sweepMergeReady: sweepMergeReadyNotifications,
};
