import {
  ChangeMapDocumentError,
  parseChangeMapDocument,
} from "../change-map-document.ts";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { localBranchRef, revParse } from "../git.ts";
import { type PrChangeMapWire, prChangeMapJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

// ===== PR change maps (#344) =====
//
// A change map is the structured, top-down account of a PR's whole change — the thing a reader
// starts from and descends into individual diffs through, instead of reassembling the picture from
// the diffs themselves. It is written by an agent launched from the PR detail and handed here as a
// document (core/change-map-document.ts); this layer owns the git + DB orchestration (validate it,
// resolve the head it describes, store it, announce it) so the CLI command and the RPC method stay
// thin.
//
// Coverage — "no diff should be unreachable from the map" — is deliberately not enforced here.
// Saving never blocks on it: the PR detail subtracts the files the map declares from the PR's
// changed files and offers the remainder as Not covered, which keeps every diff reachable whatever
// the map's quality. What *is* enforced is that the document is well formed, because there is
// nothing useful to do with a broken one but refuse it while the agent can still try again.
export const prChangeMaps = {
  /** The newest change map for a PR, or null when none has been generated. */
  get(name: string, number: number): PrChangeMapWire | null {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return prChangeMapJSON(S.latestPrChangeMap(row.id));
  },

  /**
   * Record a generated change map for a PR.
   *
   * `headSha` is the head the map was written against. It is resolved from the PR's head ref when
   * the caller does not supply one, so an agent that never looked up a SHA still produces a map
   * that can be told apart from later commits.
   */
  async create(
    name: string,
    number: number,
    input: { headSha?: string | null; document: unknown },
    sessionId?: string | null,
  ): Promise<PrChangeMapWire> {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");

    let document: ReturnType<typeof parseChangeMapDocument>;
    try {
      document = parseChangeMapDocument(input.document);
    } catch (error) {
      if (error instanceof ChangeMapDocumentError)
        throw new ServiceError(422, error.message);
      throw error;
    }

    const given = (input.headSha ?? "").trim();
    if (given && !/^[0-9a-fA-F]{7,40}$/.test(given))
      throw new ServiceError(422, "head-sha must be a git object name");
    // Git work stays outside the transaction below (AGENTS.md: command transaction boundaries).
    const headSha =
      given ||
      (await revParse(
        r.local_path,
        localBranchRef(S.getPull(row.id)!.head_ref),
      ));
    if (!headSha)
      throw new ServiceError(
        422,
        `cannot resolve the head of PR #${number} to record a change map against`,
      );

    const actor = actorFor(sessionId);
    return db.transaction(() => {
      const map = S.createPrChangeMap({
        issueId: row.id,
        headSha,
        document: JSON.stringify(document),
        createdBy: actor,
      });
      S.emitEvent(r.id, "pull_request.change_map_created", actor, {
        number,
        head_sha: headSha,
      });
      return prChangeMapJSON(map);
    });
  },
};
