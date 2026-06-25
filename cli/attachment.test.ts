import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");

let home: string;
let pngPath: string;

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Run the CLI against an isolated HOME/DB; no server — the CLI talks to core directly.
function lh(args: string[]) {
  const r = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      CLI,
      ...args,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        LOOPHUB_HOME: home,
        LOOPHUB_DB: join(home, "loophub.db"),
      },
    },
  );
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-cliattach-home-"));
  pngPath = join(home, "shot.png");
  writeFileSync(pngPath, PNG);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

test("lh attachment add uploads an image and prints embed markdown", () => {
  const { stdout, exitCode } = lh(["attachment", "add", "--file", pngPath]);
  expect(exitCode).toBe(0);
  const m = stdout.match(/^!\[shot\.png\]\(\/attachments\/([0-9a-f]{64})\)$/m);
  expect(m).not.toBeNull();
  const sha256 = m![1];
  // Blob is content-addressed on disk under $LOOPHUB_HOME/attachments/.
  expect(
    existsSync(join(home, "attachments", sha256.slice(0, 2), sha256)),
  ).toBe(true);
});

test("lh attachment add rejects a non-image file", () => {
  const txt = join(home, "note.txt");
  writeFileSync(txt, "hello");
  const { exitCode, stderr } = lh(["attachment", "add", "--file", txt]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/extension|MIME/);
});

test("lh attachment add without a file errors with usage", () => {
  const { exitCode, stderr } = lh(["attachment", "add"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("usage: lh attachment add");
});
