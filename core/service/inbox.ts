import {
  actorFor,
  clampPerPage,
  ensureWritable,
  inboxMessageJSON,
  MAX_LIST_PER_PAGE,
  repoOr404,
  S,
  ServiceError,
} from "./shared.ts";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

export const INBOX_MESSAGE_STATES = [
  "unread",
  "read",
  "archived",
  "deleted",
] as const satisfies readonly S.InboxMessageState[];

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServiceError(422, `${field} is required`);
  }
  return value.trim();
}

function requireTextBody(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ServiceError(422, "body is required");
  }
  return value;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new ServiceError(422, `${field} must be a positive integer`);
  }
  return value;
}

function normalizeSource(repoName: string, value: unknown): JsonObject {
  if (!isJsonObject(value)) {
    throw new ServiceError(422, "from must be a JSON object");
  }
  const source: JsonObject = { ...value };
  source.kind = requireNonEmpty(source.kind, "from.kind");
  source.repo = requireNonEmpty(source.repo, "from.repo");
  if (source.repo !== repoName) {
    throw new ServiceError(422, "from.repo must match the message repo");
  }
  if (source.kind === "scheduled_task") {
    source.task_id = requirePositiveInteger(source.task_id, "from.task_id");
    source.run_id = requirePositiveInteger(source.run_id, "from.run_id");
    if (source.actor != null) {
      source.actor = requireNonEmpty(source.actor, "from.actor");
    }
  } else {
    source.actor = requireNonEmpty(source.actor, "from.actor");
  }
  return source;
}

function normalizeTarget(value: unknown): JsonObject | null {
  if (value == null) return null;
  if (!isJsonObject(value)) {
    throw new ServiceError(422, "to must be a JSON object");
  }
  return { ...value };
}

function sourceActor(source: JsonObject): string {
  if (typeof source.actor === "string" && source.actor.trim()) {
    return source.actor.trim();
  }
  if (source.kind === "scheduled_task") {
    return `scheduled_task:${source.task_id}/${source.run_id}`;
  }
  return String(source.kind);
}

function requireState(value: unknown): S.InboxMessageState {
  if (!INBOX_MESSAGE_STATES.includes(value as S.InboxMessageState)) {
    throw new ServiceError(422, "invalid inbox message state");
  }
  return value as S.InboxMessageState;
}

function messageOr404(id: number): S.InboxMessageRow {
  const row = S.getInboxMessageById(id);
  if (!row) throw new ServiceError(404, "inbox message not found");
  return row;
}

export const inbox = {
  send(
    name: string,
    input: {
      from?: unknown;
      to?: unknown;
      label?: string | null;
      title?: string;
      body?: string;
    },
  ): any {
    const r = repoOr404(name);
    ensureWritable(r);

    const from = normalizeSource(r.full_name, input.from);
    const to = normalizeTarget(input.to);
    const title = requireNonEmpty(input.title, "title");
    const body = requireTextBody(input.body);
    const label = input.label?.trim() || null;

    const row = S.createInboxMessage({
      repoId: r.id,
      fromJson: JSON.stringify(from),
      toJson: to ? JSON.stringify(to) : null,
      label,
      title,
      body,
      state: "unread",
    });

    S.emitEvent(r.id, "inbox.message.created", sourceActor(from), {
      id: row.id,
      state: row.state,
      label: row.label,
    });
    return inboxMessageJSON(row);
  },

  list(
    name: string,
    opts: { state?: S.InboxMessageState; limit?: number } = {},
  ): any[] {
    const r = repoOr404(name);
    if (opts.state) requireState(opts.state);
    const limit = clampPerPage(opts.limit, 50, MAX_LIST_PER_PAGE);
    return S.listInboxMessages(r.id, { ...opts, limit }).map(inboxMessageJSON);
  },

  listAll(opts: { state?: S.InboxMessageState; limit?: number } = {}): any[] {
    if (opts.state) requireState(opts.state);
    const limit = clampPerPage(
      opts.limit,
      MAX_LIST_PER_PAGE,
      MAX_LIST_PER_PAGE,
    );
    return S.listInboxMessagesAcrossRepos({ ...opts, limit }).map(
      inboxMessageJSON,
    );
  },

  get(id: number): any {
    return inboxMessageJSON(messageOr404(id));
  },

  setState(
    id: number,
    state: S.InboxMessageState,
    sessionId?: string | null,
  ): any {
    const nextState = requireState(state);
    const current = messageOr404(id);
    const repo = S.getRepoById(current.repo_id);
    if (!repo) throw new ServiceError(404, "Not Found");
    ensureWritable(repo);

    const row =
      current.state === nextState
        ? current
        : (S.updateInboxMessageState(id, nextState) ?? messageOr404(id));

    if (current.state !== row.state) {
      S.emitEvent(row.repo_id, "inbox.message.updated", actorFor(sessionId), {
        id: row.id,
        state: row.state,
        previous_state: current.state,
      });
    }
    return inboxMessageJSON(row);
  },

  read(id: number, sessionId?: string | null): any {
    return inbox.setState(id, "read", sessionId);
  },

  unread(id: number, sessionId?: string | null): any {
    return inbox.setState(id, "unread", sessionId);
  },

  archive(id: number, sessionId?: string | null): any {
    return inbox.setState(id, "archived", sessionId);
  },

  unarchive(id: number, sessionId?: string | null): any {
    return inbox.setState(id, "read", sessionId);
  },

  delete(id: number, sessionId?: string | null): any {
    return inbox.setState(id, "deleted", sessionId);
  },
};
