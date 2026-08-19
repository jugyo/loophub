import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { localBranchRef, revParse } from "../git.ts";
import { type PrTestMapWire, prTestMapJSON } from "../serialize.ts";
import * as S from "../store.ts";
import {
  parseTestMapDocument,
  TestMapDocumentError,
} from "../test-map-document.ts";
import { actorFor, ensureWritable, issueOr404, repoOr404 } from "./shared.ts";

// ===== PR test maps (#348) =====
//
// A test map is the listing of what a PR's tests verify: the test titles, what each one checks, and
// the verbatim code — the tests read on their own instead of picked out of the diff. It is written
// by an agent launched from the PR detail and handed here as a document
// (core/test-map-document.ts); this layer owns the git + DB orchestration (validate it, resolve the
// head it describes, store it, announce it) so the CLI command and the RPC method stay thin.
//
// Completeness — "every changed test file is accounted for" — is deliberately not enforced here.
// Saving never blocks on it: the dialog subtracts the files the map lists from the PR's changed
// test files and shows the remainder as Not covered. What *is* enforced is that the document is
// well formed, because there is nothing useful to do with a broken one but refuse it while the
// agent can still try again.
export const prTestMaps = {
  /** The newest test map for a PR, or null when none has been generated. */
  get(name: string, number: number): PrTestMapWire | null {
    const r = repoOr404(name);
    const row = issueOr404(r, number, "pull");
    return prTestMapJSON(S.latestPrTestMap(row.id));
  },

  /**
   * Record a generated test map for a PR.
   *
   * `headSha` is the head the map was written against — the commit its code excerpts were read
   * from. It is resolved from the PR's head ref when the caller does not supply one, so an agent
   * that never looked up a SHA still produces a map that can be told apart from later commits.
   */
  async create(
    name: string,
    number: number,
    input: { headSha?: string | null; document: unknown },
    sessionId?: string | null,
  ): Promise<PrTestMapWire> {
    const r = repoOr404(name);
    ensureWritable(r);
    const row = issueOr404(r, number, "pull");

    let document: ReturnType<typeof parseTestMapDocument>;
    try {
      document = parseTestMapDocument(input.document);
    } catch (error) {
      if (error instanceof TestMapDocumentError)
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
        `cannot resolve the head of PR #${number} to record a test map against`,
      );

    const actor = actorFor(sessionId);
    return db.transaction(() => {
      const map = S.createPrTestMap({
        issueId: row.id,
        headSha,
        document: JSON.stringify(document),
        createdBy: actor,
      });
      S.emitEvent(r.id, "pull_request.test_map_created", actor, {
        number,
        head_sha: headSha,
      });
      return prTestMapJSON(map);
    });
  },
};
