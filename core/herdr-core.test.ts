import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "#loophub-test";
import { isServiceError, type ServiceError } from "./errors.ts";
import { callHerdrCore, herdrCoreEnv, runHerdrCore } from "./herdr-core.ts";

// A core of our own: a dedicated HC_SESSION and XDG paths, with HC_SOCKET cleared because it
// overrides them, so the tests never reach the user's core. The directory sits directly under /tmp, not os.tmpdir(): macOS caps socket paths at 103
// bytes and its per-user tmpdir alone eats most of that.
const HAS_HC = Bun.which("hc") !== null;
const DIR = mkdtempSync("/tmp/lhhc-");
const ENV = {
  ...process.env,
  HC_SOCKET: undefined,
  HC_SESSION: "lhtest",
  XDG_STATE_HOME: join(DIR, "s"),
  XDG_CONFIG_HOME: join(DIR, "c"),
  XDG_RUNTIME_DIR: join(DIR, "r"),
};

// The error a failing call rejects with, checked to be a ServiceError.
async function failure(promise: Promise<unknown>): Promise<ServiceError> {
  const error = await promise.then(
    () => expect.fail("hc call succeeded"),
    (e: unknown) => e,
  );
  expect(isServiceError(error)).toBe(true);
  return error as ServiceError;
}

afterAll(async () => {
  if (HAS_HC) await runHerdrCore(["server", "stop"], { env: ENV });
  rmSync(DIR, { recursive: true, force: true });
});

test("herdrCoreEnv drops HC_TERMINAL_ID and keeps the rest", () => {
  expect(herdrCoreEnv({ HC_TERMINAL_ID: "t1", HC_SESSION: "x" })).toEqual({
    HC_SESSION: "x",
  });
});

test("a missing hc is a visible not_installed error", async () => {
  const error = await failure(
    runHerdrCore(["ls"], { env: { ...ENV, PATH: join(DIR, "empty") } }),
  );
  expect(error.status).toBe(422);
  expect(error.data).toMatchObject({ kind: "not_installed" });
});

test("a missing hc is the same visible error over the API", async () => {
  const error = await failure(
    callHerdrCore(
      "terminal.list",
      {},
      {
        env: { ...ENV, PATH: join(DIR, "empty") },
      },
    ),
  );
  expect(error.status).toBe(422);
  expect(error.data).toMatchObject({ kind: "not_installed" });
});

test("a failure with non-JSON stderr keeps that output", async () => {
  const bin = join(DIR, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "hc"), "#!/bin/sh\necho boom >&2\nexit 7\n", {
    mode: 0o755,
  });
  const error = await failure(
    runHerdrCore(["ls"], {
      env: { ...ENV, PATH: `${bin}:${process.env.PATH}` },
    }),
  );
  expect(error.status).toBe(500);
  expect(error.message).toBe("hc exited with status 7: boom");
});

describe.skipIf(!HAS_HC)("against an isolated core", () => {
  beforeAll(async () => {
    // A freshly isolated core has no live terminals; anything else means the env reached another core.
    const status = (await runHerdrCore(["server", "status"], {
      env: ENV,
    })) as { live: number };
    expect(status.live).toBe(0);
  });

  test("returns hc's JSON on success", async () => {
    expect(await runHerdrCore(["ls"], { env: ENV })).toMatchObject({
      terminals: [],
    });
  });

  test("keeps hc's error kind, message and hint", async () => {
    const error = await failure(runHerdrCore(["get", "t99"], { env: ENV }));
    expect(error.status).toBe(404);
    expect(error.message).toContain('no terminal "t99"');
    expect(error.data).toMatchObject({ kind: "not_found" });
    expect(typeof error.data?.hint).toBe("string");
  });

  test("an unreachable core is a visible unavailable error", async () => {
    const error = await failure(
      runHerdrCore(["ls"], {
        env: { ...ENV, HC_SESSION: "lhdown", XDG_RUNTIME_DIR: "/dev/null/x" },
      }),
    );
    expect(error.status).toBe(503);
    expect(error.data).toMatchObject({ kind: "unavailable" });
  });

  test("an API call keeps hc's error kind, message and hint", async () => {
    const error = await failure(
      callHerdrCore(
        "terminal.send",
        { terminal: "t99", text: "x" },
        { env: ENV },
      ),
    );
    expect(error.status).toBe(404);
    expect(error.message).toContain('no terminal "t99"');
    expect(error.data).toMatchObject({ kind: "not_found" });
    expect(typeof error.data?.hint).toBe("string");
  });

  test("a call that does not finish in time is a visible error", async () => {
    const started = (await callHerdrCore(
      "terminal.run",
      { argv: ["sleep", "30"], no_parent: true, no_notify: true },
      { env: ENV },
    )) as { address: string };
    const error = await failure(
      callHerdrCore(
        "terminal.wait",
        { terminal: started.address },
        { env: ENV, timeoutMs: 100 },
      ),
    );
    expect(error.message).toContain("did not finish in time");
    await callHerdrCore(
      "terminal.kill",
      { terminal: started.address },
      {
        env: ENV,
      },
    );
  });

  test("a terminal started from inside an hc terminal gets no parent", async () => {
    const started = (await runHerdrCore(["run", "--bg", "sleep", "30"], {
      env: { ...ENV, HC_TERMINAL_ID: "t1" },
    })) as { address: string; parent?: string };
    expect(started.parent).toBeUndefined();
    await runHerdrCore(["kill", started.address], { env: ENV });
  });
});
