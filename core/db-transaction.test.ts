import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";

// Isolate the DB before db.ts runs its import-time setup (see store.test.ts).
const HOME = mkdtempSync(join(tmpdir(), "lh-db-tx-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let D: typeof import("./db.ts");
let S: typeof import("./store.ts");

beforeAll(async () => {
  D = await import("./db.ts");
  S = await import("./store.ts");
  D.db.exec("CREATE TABLE tx_probe (label TEXT NOT NULL)");
});

afterEach(() => {
  // Every test below must leave the connection outside a transaction; a leaked BEGIN would make
  // this DELETE (and the next test's BEGIN IMMEDIATE) fail instead of silently passing.
  D.db.run("DELETE FROM tx_probe");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

function insert(label: string): void {
  D.db.run("INSERT INTO tx_probe (label) VALUES (?)", [label]);
}

function labels(): string[] {
  return (
    D.db.query("SELECT label FROM tx_probe ORDER BY rowid").all() as {
      label: string;
    }[]
  ).map((row) => row.label);
}

test("the outermost call commits and returns the callback's value", () => {
  const returned = D.db.transaction(() => {
    insert("committed");
    return 42;
  });
  expect(returned).toBe(42);
  expect(labels()).toEqual(["committed"]);
});

test("an error rolls the outermost transaction back", () => {
  expect(() =>
    D.db.transaction(() => {
      insert("rolled-back");
      throw new Error("boom");
    }),
  ).toThrow("boom");
  expect(labels()).toEqual([]);
});

test("a nested call joins the open transaction instead of committing it", () => {
  expect(() =>
    D.db.transaction(() => {
      insert("outer");
      const inner = D.db.transaction(() => {
        insert("inner");
        return "inner-value";
      });
      expect(inner).toBe("inner-value");
      // The inner call returned without committing: the outer failure must still discard its write.
      throw new Error("outer failed after the inner call succeeded");
    }),
  ).toThrow("outer failed after the inner call succeeded");
  expect(labels()).toEqual([]);
});

test("an inner failure rolls back the whole outer transaction", () => {
  expect(() =>
    D.db.transaction(() => {
      insert("outer");
      D.db.transaction(() => {
        insert("inner");
        throw new Error("inner failed");
      });
    }),
  ).toThrow("inner failed");
  expect(labels()).toEqual([]);
});

test("a store helper is atomic on its own and joins an outer transaction", () => {
  const repo = S.createRepo("me/tx-store", "/tmp/tx-store");

  // Standalone: the helper owns its transaction and commits.
  const standalone = S.createIssue(repo.id, "issue", "standalone", "", "me");
  expect(S.getIssueById(standalone.id)?.title).toBe("standalone");

  // Joined: the same helper commits nothing of its own when the outer command fails.
  let joinedId = 0;
  expect(() =>
    D.db.transaction(() => {
      joinedId = S.createIssue(repo.id, "issue", "joined", "", "me").id;
      throw new Error("command failed");
    }),
  ).toThrow("command failed");
  expect(joinedId).toBeGreaterThan(0);
  expect(S.getIssueById(joinedId)).toBeNull();
});

test("a native async callback is rejected before it runs", () => {
  let called = false;
  const callback = async () => {
    called = true;
    insert("async");
  };
  expect(() => D.db.transaction(callback as unknown as () => void)).toThrow(
    TypeError,
  );
  expect(called).toBe(false);
  // No transaction was opened, so the connection is still usable.
  D.db.transaction(() => insert("after-async"));
  expect(labels()).toEqual(["after-async"]);
});

test("a thenable returned through a type escape rolls back with a visible error", () => {
  // A type assertion or a plain JavaScript caller can hand us a non-async function that still
  // returns a promise; the runtime check is what keeps a half-finished command from committing.
  const escaped = (() => {
    insert("thenable");
    return Promise.resolve();
  }) as unknown as () => void;

  expect(() => D.db.transaction(escaped)).toThrow(/thenable/);
  expect(labels()).toEqual([]);
});
