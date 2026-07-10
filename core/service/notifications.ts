import {
  actorFor,
  clampPerPage,
  ensureWritable,
  MAX_LIST_PER_PAGE,
  notificationJSON,
  S,
  ServiceError,
} from "./shared.ts";

const MAX_NOTIFICATION_TITLE_LENGTH = 200;
const MAX_NOTIFICATION_BODY_LENGTH = 4096;

function notificationOr404(id: number): S.NotificationRow {
  const row = S.getNotificationById(id);
  if (!row) throw new ServiceError(404, "notification not found");
  return row;
}

function repoOr404(repoName: string): S.Repo {
  const [owner, name] = S.splitName(repoName);
  const repo = S.getRepo(owner, name);
  if (!repo) throw new ServiceError(404, "repo not found");
  return repo;
}

function bodyForSignal(signal: S.NotificationSignalRow): string {
  if (signal.kind === "implementation_done") {
    return `PR #${signal.number} is ready for review.`;
  }
  if (signal.kind === "over_budget") {
    return `PR #${signal.number} was stopped after exceeding the configured budget.`;
  }
  return `PR #${signal.number} needs human attention before work can continue.`;
}

function titleForSignal(signal: S.NotificationSignalRow): string {
  if (signal.kind === "implementation_done") return "Implementation complete";
  if (signal.kind === "over_budget") return "Over budget";
  return "Human attention needed";
}

function assertKind(kind: unknown): S.NotificationKind {
  if (
    kind === "implementation_done" ||
    kind === "over_budget" ||
    kind === "human_attention"
  ) {
    return kind;
  }
  throw new ServiceError(
    422,
    "kind must be implementation_done, over_budget, or human_attention",
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

function backfillFromSignals(): void {
  const cursors = S.notificationSourceCursors();
  const highWatermarks = S.notificationSourceHighWatermarks();
  for (const signal of S.listNotificationSignalRows(cursors, highWatermarks)) {
    const row = S.createNotification({
      repoId: signal.repo_id,
      kind: signal.kind,
      title: titleForSignal(signal),
      body: bodyForSignal(signal),
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
  },

  list(opts: { limit?: number } = {}): any[] {
    backfillFromSignals();
    const limit = clampPerPage(opts.limit, 50, MAX_LIST_PER_PAGE);
    return S.listNotifications({ limit }).map(notificationJSON);
  },

  unreadCount(): { count: number } {
    backfillFromSignals();
    return { count: S.unreadNotificationCount() };
  },

  read(id: number, sessionId?: string | null): any {
    const current = notificationOr404(id);
    const repo = S.getRepoById(current.repo_id);
    if (!repo) throw new ServiceError(404, "Not Found");

    const row = S.markNotificationRead(id) ?? notificationOr404(id);
    if (!current.read_at && row.read_at) {
      S.emitEvent(row.repo_id, "notification.updated", actorFor(sessionId), {
        id: row.id,
        read_at: row.read_at,
      });
    }
    return notificationJSON(row);
  },

  readAll(sessionId?: string | null): { count: number } {
    backfillFromSignals();
    const rows = S.markAllNotificationsRead();
    const repoIds = new Set(rows.map((row) => row.repo_id));
    const actor = actorFor(sessionId);
    for (const repoId of repoIds) {
      S.emitEvent(repoId, "notification.updated", actor, { read_all: true });
    }
    return { count: rows.length };
  },
};
