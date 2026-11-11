import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test, vi } from "#loophub-test";

// Drives the real `lh-job-queue` process against a temporary database to cover what only the
// process boundary shows: signals, process groups, and a restart after a crash.
const home = mkdtempSync(join(tmpdir(), "lh-job-queue-"));
process.env.LOOPHUB_HOME = home;
process.env.LOOPHUB_DB = join(home, "test.db");

let jobs: typeof import("../core/store/jobs.ts");
let db: typeof import("../core/db.ts").db;

beforeAll(async () => {
  jobs = await import("../core/store/jobs.ts");
  db = (await import("../core/db.ts")).db;
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

const row = (id: number) =>
  db.query("SELECT status, error FROM jobs WHERE id = ?").get(id) as {
    status: string;
    error: string | null;
  };

function startQueue(graceMs: number) {
  return Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "job-queue-index.ts"),
      "--poll-ms",
      "50",
      "--closed-pull-cleanup-sweep-ms",
      "0",
    ],
    {
      env: {
        ...process.env,
        LOOPHUB_JOB_SHUTDOWN_GRACE_MS: String(graceMs),
      },
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("graceful stop lets a job finish within the grace period", async () => {
  const id = jobs.enqueue({
    type: "shell",
    dedupeKey: "graceful-finish",
    params: { command: "sleep 0.3" },
  });
  const queue = startQueue(5000);
  await vi.waitFor(() => expect(row(id).status).toBe("running"), {
    timeout: 5000,
  });
  queue.kill("SIGTERM");
  expect(await queue.exited).toBe(0);
  expect(row(id)).toEqual({ status: "done", error: null });
});

test("graceful stop interrupts a job past the grace period and kills its descendants", async () => {
  const pidFile = join(home, "descendant.pid");
  const id = jobs.enqueue({
    type: "shell",
    dedupeKey: "graceful-interrupt",
    params: { command: `sleep 30 & echo $! > ${pidFile}; wait` },
  });
  const queued = jobs.enqueue({
    type: "shell",
    dedupeKey: "graceful-not-claimed",
    params: { command: "true" },
  });
  const queue = startQueue(200);
  await vi.waitFor(() => expect(row(id).status).toBe("running"), {
    timeout: 5000,
  });
  await vi.waitFor(() => readFileSync(pidFile, "utf8").trim(), {
    timeout: 5000,
  });
  const descendant = Number(readFileSync(pidFile, "utf8").trim());
  // Concurrency allows the second job too; it has finished by now, so stop
  // with only the long job still running.
  await vi.waitFor(() => expect(row(queued).status).toBe("done"), {
    timeout: 5000,
  });
  queue.kill("SIGTERM");
  expect(await queue.exited).toBe(0);
  expect(row(id).status).toBe("failed");
  expect(row(id).error).toMatch(/^interrupted:/);
  await vi.waitFor(() => expect(alive(descendant)).toBe(false), {
    timeout: 5000,
  });
});

test("a stopping queue claims no new job", async () => {
  const blocker = jobs.enqueue({
    type: "shell",
    dedupeKey: "stopping-blocker",
    params: { command: "sleep 1" },
  });
  const queue = startQueue(5000);
  await vi.waitFor(() => expect(row(blocker).status).toBe("running"), {
    timeout: 5000,
  });
  queue.kill("SIGTERM");
  await Bun.sleep(100);
  const late = jobs.enqueue({
    type: "shell",
    dedupeKey: "stopping-late",
    params: { command: "true" },
  });
  expect(await queue.exited).toBe(0);
  expect(row(blocker).status).toBe("done");
  expect(row(late).status).toBe("queued");
  db.run("DELETE FROM jobs WHERE id = ?", [late]);
});

test("after a crash, restart fails the stale running job instead of re-running it", async () => {
  const marker = join(home, "ran-twice");
  const id = jobs.enqueue({
    type: "shell",
    dedupeKey: "crashed",
    params: { command: `echo x >> ${marker}; sleep 30` },
  });
  const crashed = startQueue(5000);
  await vi.waitFor(() => expect(row(id).status).toBe("running"), {
    timeout: 5000,
  });
  await vi.waitFor(() => readFileSync(marker, "utf8"), { timeout: 5000 });
  crashed.kill("SIGKILL");
  await crashed.exited;
  expect(row(id).status).toBe("running");
  // The crashed process's shell keeps running in its own process group; stop it here.
  const pgrep = Bun.spawnSync(["pgrep", "-f", `echo x >> ${marker}`]);
  for (const pid of pgrep.stdout.toString().split("\n").filter(Boolean))
    process.kill(-Number(pid), "SIGKILL");
  db.run("UPDATE jobs SET heartbeat_at = ? WHERE id = ?", [
    "2000-01-01T00:00:00Z",
    id,
  ]);

  const restarted = startQueue(5000);
  await vi.waitFor(() => expect(row(id).status).toBe("failed"), {
    timeout: 5000,
  });
  expect(row(id).error).toMatch(/heartbeat went stale/);
  restarted.kill("SIGTERM");
  expect(await restarted.exited).toBe(0);
  expect(readFileSync(marker, "utf8")).toBe("x\n");
});
