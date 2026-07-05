import type { FollowOptions, LoopEvent } from "./shared.ts";
import {
  clampPerPage,
  followEvents,
  formatEvent,
  MAX_EVENTS_PER_PAGE,
  S,
} from "./shared.ts";

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
    return rows.map((row: any) => {
      const repo =
        opts.repo ??
        (row.repo_id != null
          ? S.getRepoById(row.repo_id)?.full_name
          : undefined);
      return formatEvent(row, repo);
    });
  },

  // Live tail: subscribe to the web server's SSE feed (replay-then-subscribe) and invoke
  // `onEvent` for each matching event until `signal` aborts. Unlike `list`, this needs the
  // resident lh-web process (HTTP); see core/events-follow.ts.
  follow(
    opts: FollowOptions,
    onEvent: (event: LoopEvent) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    return followEvents(opts, onEvent, signal);
  },
};
