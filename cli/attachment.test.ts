import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

const CLI = join(import.meta.dirname, "index.ts");

let home: string;
let pngPath: string;
let htmlPath: string;

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

// Run the CLI against an isolated HOME/DB; no server — the CLI talks to core directly.
function lh(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LOOPHUB_HOME: home,
      LOOPHUB_DB: join(home, "loophub.db"),
    },
  });
  return { stdout: r.stdout, stderr: r.stderr, exitCode: r.status ?? 0 };
}

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "loophub-cliattach-home-"));
  pngPath = join(home, "shot.png");
  htmlPath = join(home, "report.html");
  writeFileSync(pngPath, PNG);
  writeFileSync(htmlPath, "<!doctype html><script>alert('no')</script>");
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

test("lh attachment add uploads HTML and prints a file link", () => {
  const { stdout, exitCode } = lh(["attachment", "add", "--file", htmlPath]);
  expect(exitCode).toBe(0);
  const m = stdout.match(
    /^\[report\.html\]\(\/attachments\/([0-9a-f]{64})\)$/m,
  );
  expect(m).not.toBeNull();
  const sha256 = m![1];
  expect(
    existsSync(join(home, "attachments", sha256.slice(0, 2), sha256)),
  ).toBe(true);
});

test("lh attachment add uploads a document and lh attachment get reads it back", () => {
  const doc = join(home, "findings.md");
  const text = "# 調査結果\n\n- ひとつめ\n";
  writeFileSync(doc, text);
  const added = lh(["attachment", "add", "--file", doc]);
  expect(added.exitCode).toBe(0);
  const m = added.stdout.match(
    /^\[findings\.md\]\((\/attachments\/[0-9a-f]{64})\)$/m,
  );
  expect(m).not.toBeNull();
  const url = m![1];

  // An agent reads the linked document straight from the body's URL.
  const got = lh(["attachment", "get", url]);
  expect(got.exitCode).toBe(0);
  expect(got.stdout).toBe(text);

  const json = lh(["attachment", "get", url, "--json"]);
  const meta = JSON.parse(json.stdout);
  expect(meta.mime).toBe("text/markdown");
  expect(meta.url).toBe(url);
  expect(existsSync(meta.path)).toBe(true);

  const out = join(home, "copy.md");
  expect(lh(["attachment", "get", url, "--output", out]).exitCode).toBe(0);
  expect(readFileSync(out, "utf8")).toBe(text);
});

test("lh attachment get rejects an unknown reference", () => {
  const { exitCode, stderr } = lh(["attachment", "get", "0".repeat(64)]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/not found/);
});

test("lh attachment add rejects an unsupported attachment file", () => {
  const pdf = join(home, "note.pdf");
  writeFileSync(pdf, "hello");
  const { exitCode, stderr } = lh(["attachment", "add", "--file", pdf]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toMatch(/extension|MIME/);
});

test("lh attachment add without a file errors with usage", () => {
  const { exitCode, stderr } = lh(["attachment", "add"]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("usage: lh attachment add");
});
