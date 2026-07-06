import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  RetroValidationError,
  validateFindings,
  validateRubric,
} from "./retro.ts";

// Isolate the DB before db.ts runs its import-time setup (see store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-retro-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("./store.ts");
let svc: typeof import("./service.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  svc = await import("./service.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

// ---- pure validation (no DB) ----
describe("validateRubric / validateFindings", () => {
  test("normalizes a valid rubric, dropping extra keys", () => {
    const out = validateRubric([
      {
        id: "R1",
        signal: "user turns",
        value: 3,
        severity: "warn",
        note: "n",
        x: 1,
      },
      { id: "R8", signal: "elapsed", value: null, severity: "ok" },
    ]);
    expect(out).toEqual([
      { id: "R1", signal: "user turns", value: 3, severity: "warn", note: "n" },
      { id: "R8", signal: "elapsed", value: null, severity: "ok", note: "" },
    ]);
  });

  test("rejects bad severity and non-array input", () => {
    expect(() =>
      validateRubric([{ id: "R1", signal: "s", severity: "critical" }]),
    ).toThrow(RetroValidationError);
    expect(() => validateRubric({} as unknown)).toThrow(/must be an array/);
  });

  test("findings keep proposed_action only when non-empty", () => {
    const out = validateFindings([
      {
        category: "scope",
        severity: "bad",
        note: "extra file touched",
        evidence_ref: "pr#155",
        proposed_action: "split it",
      },
      {
        category: "review",
        severity: "ok",
        note: "clean",
        proposed_action: "  ",
      },
    ]);
    expect(out[0].proposed_action).toBe("split it");
    expect(out[1]).not.toHaveProperty("proposed_action");
    expect(out[1].evidence_ref).toBe("");
  });

  test("findings require category and note", () => {
    expect(() =>
      validateFindings([{ category: "scope", severity: "bad" }]),
    ).toThrow(/note/);
  });
});

// ---- store + service integration (DB-backed) ----
describe("retros store + service", () => {
  const repo = "me/retro-app";

  function seedMergedPr(opts: {
    title: string;
    link?: boolean;
    session?: string;
  }) {
    const r =
      S.getRepo("me", "retro-app") ?? S.createRepo(repo, "/tmp/retro-app");
    let issueId: number | null = null;
    let sessionRowId: string | null = null;
    if (opts.link) {
      const issue = S.createIssue(
        r.id,
        "issue",
        `${opts.title} issue`,
        "",
        "me",
      ) as any;
      issueId = issue.id;
      if (opts.session) {
        S.registerAgentSession(opts.session, "lh-dev", opts.session);
        sessionRowId = opts.session;
      }
    }
    const pr = S.createIssue(
      r.id,
      "pull",
      opts.title,
      issueId ? `Closes #${S.getIssueById(issueId)!.number}` : "",
      "bot",
    ) as any;
    // The implementation session is attributed to the PR row (pulls.session_id); retro resolves it
    // from there (#186).
    S.createPull(
      pr.id,
      `feat-${pr.number}`,
      "main",
      "sha",
      issueId,
      sessionRowId,
    );
    S.setMerged(pr.id, `merge-${pr.number}`, "squash");
    return { repoRow: r, prNumber: pr.number, issueId };
  }

  test("create resolves PR->issue->session, persists, and emits the event", () => {
    const { prNumber } = seedMergedPr({
      title: "linked pr",
      link: true,
      session: "sess-retro-1",
    });
    const before = svc.events
      .list({ repo, limit: 100 })
      .filter((e) => e.type === "session.retro.created").length;

    const retro = svc.retros.create(repo, {
      pr: prNumber,
      rubric: [{ id: "R3", signal: "review rounds", value: 1, severity: "ok" }],
      findings: [
        {
          category: "process",
          severity: "warn",
          note: "evidence thin",
          evidence_ref: "pr",
        },
      ],
    });

    expect(retro.pr?.number).toBe(prNumber);
    expect(retro.issue?.number).toBeDefined();
    expect(retro.session_id).toBe("sess-retro-1");
    expect(retro.status).toBe("draft");
    expect(retro.rubric).toHaveLength(1);
    expect(retro.findings[0].category).toBe("process");

    const evs = svc.events
      .list({ repo, limit: 100 })
      .filter((e) => e.type === "session.retro.created");
    expect(evs.length).toBe(before + 1);
    const payload = evs.at(-1)!.payload as any;
    expect(payload.retro_id).toBe(retro.id);
    expect(payload.pr_number).toBe(prNumber);
    expect(payload.session_id).toBe("sess-retro-1");

    // round-trips through get/list
    expect(svc.retros.get(repo, retro.id).id).toBe(retro.id);
    expect(svc.retros.list(repo, { pr: prNumber }).map((r) => r.id)).toContain(
      retro.id,
    );
  });

  test("create on a link-less PR leaves session_id NULL but still stands", () => {
    const { prNumber } = seedMergedPr({ title: "orphan pr" });
    const retro = svc.retros.create(repo, {
      pr: prNumber,
      rubric: [],
      findings: [],
    });
    expect(retro.session_id).toBeNull();
    expect(retro.issue).toBeNull();
    expect(retro.pr?.number).toBe(prNumber);
  });

  test("invalid rubric shape surfaces as a 422", () => {
    const { prNumber } = seedMergedPr({ title: "bad input pr" });
    expect(() =>
      svc.retros.create(repo, {
        pr: prNumber,
        rubric: [{ id: "R1", signal: "s", severity: "nope" }],
        findings: [],
      }),
    ).toThrow(/severity/);
  });

  test("pending lists merged PRs without a retro, excluding ones already retro'd", () => {
    const { prNumber } = seedMergedPr({ title: "pending pr" });
    let pending = svc.retros.pending(repo, {});
    expect(pending.map((p) => p.number)).toContain(prNumber);

    svc.retros.create(repo, { pr: prNumber, rubric: [], findings: [] });
    pending = svc.retros.pending(repo, {});
    expect(pending.map((p) => p.number)).not.toContain(prNumber);
  });
});
