import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function runWeb(root: string, args: string[]) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "web/server/index.ts",
      ...args,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        LOOPHUB_HOME: root,
      },
      encoding: "utf8",
    },
  );
}

function webLog(root: string): string {
  const logDir = join(root, "logs");
  const logFiles = readdirSync(logDir).filter(
    (name) => name.startsWith("lh-web.") && name.endsWith(".log"),
  );
  expect(logFiles).toHaveLength(1);
  return readFileSync(join(logDir, logFiles[0]), "utf8");
}

test("argument errors are written to stderr and the web log", () => {
  const root = mkdtempSync(join(tmpdir(), "lh-web-args-log-"));

  try {
    const result = runWeb(root, ["--unknown-option"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("unknown option: --unknown-option");
    expect(webLog(root)).toContain("unknown option: --unknown-option");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("listen errors are written to stderr and the web log", async () => {
  const root = mkdtempSync(join(tmpdir(), "lh-web-listen-log-"));
  const blocker = createServer();

  try {
    await new Promise<void>((resolve) =>
      blocker.listen(0, "127.0.0.1", resolve),
    );
    const address = blocker.address();
    if (!address || typeof address === "string") {
      throw new Error("expected a TCP listener address");
    }

    const result = runWeb(root, ["--port", String(address.port)]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("EADDRINUSE");
    expect(webLog(root)).toContain("EADDRINUSE");
  } finally {
    await new Promise<void>((resolve, reject) => {
      blocker.close((error) => (error ? reject(error) : resolve()));
    });
    rmSync(root, { recursive: true, force: true });
  }
});
