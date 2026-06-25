import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";
// NB: only `import type` (erased) at module top — a value import of any core module would
// open the production DB before the env override below runs (imports are hoisted). The
// store + events-follow values are loaded via dynamic import in beforeAll.
import type { LoopEvent } from "./event-hub.ts";

// Isolate the DB before db.ts runs its import-time setup (same pattern as store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-follow-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let S: typeof import("./store.ts");
let F: typeof import("./events-follow.ts");

beforeAll(async () => {
  S = await import("./store.ts");
  F = await import("./events-follow.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

const frame = (n: unknown) => `event: loophub\ndata: ${JSON.stringify(n)}\n\n`;
const notify = (event: Partial<LoopEvent>) => ({
  jsonrpc: "2.0",
  method: "events/notify",
  params: event,
});

describe("createSseParser", () => {
  test("emits one notification per loophub frame", () => {
    const parse = F.createSseParser();
    const out = parse(frame(notify({ id: 1 })) + frame(notify({ id: 2 })));
    expect(out.map((n) => n.params.id)).toEqual([1, 2]);
  });

  test("buffers a frame split across chunks", () => {
    const parse = F.createSseParser();
    const whole = frame(notify({ id: 7, type: "issue.opened" }));
    const mid = Math.floor(whole.length / 2);
    expect(parse(whole.slice(0, mid))).toEqual([]);
    const out = parse(whole.slice(mid));
    expect(out).toHaveLength(1);
    expect(out[0].params).toMatchObject({ id: 7, type: "issue.opened" });
  });

  test("ignores heartbeat comments and non-loophub frames", () => {
    const parse = F.createSseParser();
    const out = parse(
      ": heartbeat\n\n" +
        "event: other\ndata: {}\n\n" +
        frame(notify({ id: 3 })),
    );
    expect(out.map((n) => n.params.id)).toEqual([3]);
  });

  test("skips a malformed frame without throwing", () => {
    const parse = F.createSseParser();
    const out = parse(
      `event: loophub\ndata: {not json}\n\n${frame(notify({ id: 5 }))}`,
    );
    expect(out.map((n) => n.params.id)).toEqual([5]);
  });

  test("throws if the buffer grows past the cap without a frame terminator", () => {
    const parse = F.createSseParser();
    expect(() => parse("x".repeat(5 * 1024 * 1024))).toThrow(/buffer limit/);
  });
});

describe("eventMatchesLabels", () => {
  const ev = (over: Partial<LoopEvent>): LoopEvent => ({
    id: 1,
    type: "issue.labeled",
    actor: "me",
    payload: {},
    created_at: "now",
    ...over,
  });

  test("empty label set matches everything", () => {
    expect(F.eventMatchesLabels(ev({}), [])).toBe(true);
  });

  test("matches when the event's issue carries a requested label", () => {
    const repo = S.createRepo("me/follow-a", "/tmp/follow-a");
    const issue = S.createIssue(repo.id, "issue", "t", "b", "me") as {
      id: number;
      number: number;
    };
    S.addLabels(repo.id, issue.id, ["bug", "ready-to-build"]);
    const event = ev({
      repo: "me/follow-a",
      payload: { number: issue.number },
    });
    expect(F.eventMatchesLabels(event, ["bug"])).toBe(true);
    expect(F.eventMatchesLabels(event, ["nope"])).toBe(false);
  });

  test("no match when event lacks repo or a numeric payload.number", () => {
    expect(F.eventMatchesLabels(ev({ payload: { number: 1 } }), ["bug"])).toBe(
      false,
    );
    expect(
      F.eventMatchesLabels(ev({ repo: "me/follow-a", payload: {} }), ["bug"]),
    ).toBe(false);
  });

  test("no match when the issue does not exist", () => {
    const repo = S.createRepo("me/follow-b", "/tmp/follow-b");
    expect(repo.full_name).toBe("me/follow-b");
    const event = ev({ repo: "me/follow-b", payload: { number: 999 } });
    expect(F.eventMatchesLabels(event, ["bug"])).toBe(false);
  });
});

// Drive followEvents without a socket by stubbing fetch with a ReadableStream SSE body
// (the sandbox blocks real listen()). Covers the fetch -> stream -> parse -> emit path
// and the unreachable / non-OK / abort branches.
describe("followEvents", () => {
  afterEach(() => vi.unstubAllGlobals());

  const sseStream = (frames: string[]) => {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(enc.encode(f));
        controller.close();
      },
    });
  };

  test("emits each replayed event (heartbeats ignored), then resolves on close", async () => {
    const frames = [
      frame(notify({ id: 1, type: "a", actor: "x", payload: {} })),
      ": heartbeat\n\n",
      frame(notify({ id: 2, type: "b", actor: "y", payload: {} })),
    ];
    vi.stubGlobal(
      "fetch",
      async () => new Response(sseStream(frames), { status: 200 }),
    );
    const got: number[] = [];
    await F.followEvents({}, (e) => got.push(e.id));
    expect(got).toEqual([1, 2]);
  });

  test("throws a clear error when the server is unreachable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });
    await expect(F.followEvents({}, () => {})).rejects.toThrow(
      /is lh-web running/,
    );
  });

  test("throws on a non-OK response", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    await expect(F.followEvents({}, () => {})).rejects.toThrow(/HTTP 503/);
  });

  test("moves basic-auth userinfo into a header and keeps it out of error text", async () => {
    process.env.LOOPHUB_URL = "http://user:secret@127.0.0.1:65535";
    let seenAuth: string | undefined;
    let seenHref = "";
    vi.stubGlobal("fetch", async (input: URL, init: RequestInit) => {
      seenHref = input.href;
      seenAuth = (init.headers as Record<string, string>).authorization;
      throw new Error("boom");
    });
    const err = (await F.followEvents({}, () => {}).catch((e) => e)) as Error;
    delete process.env.LOOPHUB_URL;
    // URL handed to fetch is credential-free; auth rode along as a header instead.
    expect(seenHref).not.toContain("secret");
    expect(seenAuth).toBe(
      `Basic ${Buffer.from("user:secret").toString("base64")}`,
    );
    // The thrown message must not echo the credentials.
    expect(err.message).not.toContain("secret");
    expect(err.message).toContain("is lh-web running");
  });

  test("malformed percent-encoded credentials fall back to the raw value (no URIError)", async () => {
    process.env.LOOPHUB_URL = "http://a%zz:p@127.0.0.1:65535";
    let seenAuth: string | undefined;
    vi.stubGlobal("fetch", async (_input: URL, init: RequestInit) => {
      seenAuth = (init.headers as Record<string, string>).authorization;
      throw new Error("boom");
    });
    const err = (await F.followEvents({}, () => {}).catch((e) => e)) as Error;
    delete process.env.LOOPHUB_URL;
    // Raw "a%zz" is used verbatim instead of throwing; the clean error still surfaces.
    expect(seenAuth).toBe(`Basic ${Buffer.from("a%zz:p").toString("base64")}`);
    expect(err.message).toContain("is lh-web running");
  });

  test("resolves cleanly (no throw) when aborted before connecting", async () => {
    const ac = new AbortController();
    ac.abort();
    vi.stubGlobal("fetch", async () => {
      throw new Error("aborted");
    });
    await expect(
      F.followEvents({}, () => {}, ac.signal),
    ).resolves.toBeUndefined();
  });
});
