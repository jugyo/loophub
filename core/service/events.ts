import type { LoopEvent } from "./shared.ts";
import { clampPerPage, formatEvent, MAX_EVENTS_PER_PAGE, S } from "./shared.ts";

// ===== events =====
export const events = {
  list(
    opts: {
      since?: number;
      repo?: string | null;
      labels?: string[];
      order?: "asc" | "desc";
      limit?: number;
    } = {},
  ): LoopEvent[] {
    const since = Number(opts.since ?? 0);
    const limit = clampPerPage(
      opts.limit,
      MAX_EVENTS_PER_PAGE,
      MAX_EVENTS_PER_PAGE,
    );
    const labels = opts.labels ?? [];
    const order = opts.order === "desc" ? "desc" : "asc";
    let repoId: number | null = null;
    if (opts.repo) {
      const [o, n] = opts.repo.split("/");
      const r = S.getRepo(o, n);
      if (!r) return []; // unknown repo filter -> empty
      repoId = r.id;
    }
    const rows = S.listEvents(since, repoId, limit, labels, order);
    return rows.map((row) => {
      const repo =
        opts.repo ??
        (row.repo_id != null
          ? S.getRepoById(row.repo_id)?.full_name
          : undefined);
      return formatEvent(row, repo);
    });
  },

  // Thin pass-through so callers outside core/, such as lh-worker, don't reach into core/store
  // directly to write an event.
  emit(
    repoId: number | null,
    type: string,
    actor: string,
    payload: unknown,
  ): S.EventRow {
    return S.emitEvent(repoId, type, actor, payload);
  },

  // Single bounded page of raw event rows after `since` (repoId filter, or null = all repos),
  // ascending by id — a direct pass-through with no formatting. Used where a caller manages its
  // own paging/cursor loop, including lh-worker's event dispatch loop.
  page(since: number, repoId: number | null, limit: number): S.EventRow[] {
    return S.listEvents(since, repoId, limit);
  },

  // Highest known event id, or 0 if none exist yet. Used to seed a tail/worker cursor at
  // startup so it only sees events from this point forward.
  newestId(): number {
    const newest = S.listEvents(0, null, 1, undefined, "desc");
    return newest.length ? newest[0].id : 0;
  },
};
