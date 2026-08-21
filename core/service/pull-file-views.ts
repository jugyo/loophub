import { type PullFileViewWire, pullFileViewJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

/**
 * Which of a PR's changed files the supervisor has already reviewed (#2502).
 *
 * The record is append-only, so `set` never rewrites an earlier row: marking a file again after new
 * commits adds a second row, and unmarking it adds a row that says so. What the screens read is the
 * newest row per path, which `list` returns — the superseded ones stay as the record of how far a
 * reader had got at each point.
 */
export const pullFileViews = {
  list(name: string, number: number): PullFileViewWire[] {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return S.latestPullFileViews(row.id)
      .filter((view) => view.viewed === 1)
      .map(pullFileViewJSON);
  },

  /**
   * Append a viewed / not-viewed record for one file, and return the PR's viewed files afterwards.
   *
   * `sha` is the file's newest PR commit as the caller saw it, not as it is now: it pins the
   * version that was actually read, so a commit landing on the file between the read and the click
   * still shows up as unread work.
   */
  set(
    name: string,
    number: number,
    path: string,
    sha: string | null,
    viewed: boolean,
  ): PullFileViewWire[] {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");
    S.addPullFileView(row.id, path, viewed ? sha : null, viewed);
    return S.latestPullFileViews(row.id)
      .filter((view) => view.viewed === 1)
      .map(pullFileViewJSON);
  },
};
