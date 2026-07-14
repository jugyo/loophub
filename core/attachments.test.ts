import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";

// Isolate the DB/HOME before importing the module (db.ts opens at import time).
const HOME = mkdtempSync(join(tmpdir(), "lh-attach-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

let A: typeof import("./attachments.ts");

// A 1x1 transparent PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
const HTML = Buffer.from("<!doctype html><script>alert('no')</script>");

beforeAll(async () => {
  A = await import("./attachments.ts");
});

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true });
});

test("saveAttachment stores a content-addressed blob and returns url + markdown", () => {
  const r = A.saveAttachment({ data: PNG, filename: "shot.png", author: "me" });
  expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(r.mime).toBe("image/png");
  expect(r.size).toBe(PNG.length);
  expect(r.url).toBe(`/attachments/${r.sha256}`);
  expect(r.markdown).toBe(`![shot.png](/attachments/${r.sha256})`);

  const path = A.blobPath(r.sha256);
  expect(path).toBe(join(HOME, "attachments", r.sha256.slice(0, 2), r.sha256));
  expect(existsSync(path)).toBe(true);
  expect(readFileSync(path).equals(PNG)).toBe(true);
});

test("saveAttachment stores HTML and returns a download link", () => {
  const r = A.saveAttachment({
    data: HTML,
    filename: "report.html",
    mime: "text/html",
    author: "me",
  });
  expect(r.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(r.mime).toBe("text/html");
  expect(r.url).toBe(`/attachments/${r.sha256}`);
  expect(r.markdown).toBe(`[report.html](/attachments/${r.sha256})`);
  expect(readFileSync(A.blobPath(r.sha256)).equals(HTML)).toBe(true);

  const duplicate = A.saveAttachment({
    data: HTML,
    filename: "copy.htm",
    mime: "text/html",
    author: "you",
  });
  expect(duplicate.sha256).toBe(r.sha256);
  expect(duplicate.filename).toBe("report.html");
  expect(duplicate.author).toBe("me");
});

test("saveAttachment accepts the .htm extension and canonicalizes its MIME", () => {
  const r = A.saveAttachment({
    data: Buffer.from("<!doctype html><title>HTM</title>"),
    filename: "report.htm",
    mime: "text/html; charset=utf-8",
    author: "me",
  });
  expect(r.mime).toBe("text/html");
  expect(r.markdown).toBe(`[report.htm](/attachments/${r.sha256})`);
});

test("re-uploading the same bytes converges on one blob and one row (dedup)", () => {
  const a = A.saveAttachment({ data: PNG, filename: "a.png", author: "me" });
  const b = A.saveAttachment({ data: PNG, filename: "b.png", author: "you" });
  expect(b.sha256).toBe(a.sha256);
  // First write wins: filename/author from the original row are kept.
  expect(b.filename).toBe(a.filename);
  expect(b.author).toBe(a.author);
});

test("re-uploading the same bytes with a different MIME type is rejected", () => {
  const imageFirst = Buffer.from("same bytes, image first");
  A.saveAttachment({
    data: imageFirst,
    filename: "first.png",
    mime: "image/png",
    author: "me",
  });
  expect(() =>
    A.saveAttachment({
      data: imageFirst,
      filename: "second.html",
      mime: "text/html",
      author: "you",
    }),
  ).toThrowError(/does not match stored attachment MIME/);

  const htmlFirst = Buffer.from("same bytes, HTML first");
  A.saveAttachment({
    data: htmlFirst,
    filename: "first.html",
    mime: "text/html",
    author: "me",
  });
  expect(() =>
    A.saveAttachment({
      data: htmlFirst,
      filename: "second.png",
      mime: "image/png",
      author: "you",
    }),
  ).toThrowError(/does not match stored attachment MIME/);
});

test("getAttachment returns stored metadata, null when missing", () => {
  const a = A.saveAttachment({ data: PNG, filename: "g.png", author: "me" });
  expect(A.getAttachment(a.sha256)?.mime).toBe("image/png");
  expect(A.getAttachment("0".repeat(64))).toBeNull();
});

test("declared MIME and extension are validated and must agree", () => {
  // jpg extension claiming png MIME is rejected.
  expect(() =>
    A.saveAttachment({
      data: PNG,
      filename: "x.jpg",
      mime: "image/png",
      author: "me",
    }),
  ).toThrowError(/does not match/);
  // jpeg extension + image/jpeg MIME is accepted (canonicalized). Use distinct
  // bytes so content-addressing doesn't dedup onto the earlier PNG row.
  const ok = A.saveAttachment({
    data: Buffer.from("distinct jpeg bytes"),
    filename: "x.jpeg",
    mime: "image/jpeg",
    author: "me",
  });
  expect(ok.mime).toBe("image/jpeg");
});

test("empty / octet-stream MIME falls back to the extension (browser drop case)", () => {
  // A browser that can't infer a dropped image's type sends application/octet-stream;
  // a valid extension must still be accepted and canonicalized.
  const a = A.saveAttachment({
    data: Buffer.from("octet bytes"),
    filename: "drop.png",
    mime: "application/octet-stream",
    author: "me",
  });
  expect(a.mime).toBe("image/png");
  const b = A.saveAttachment({
    data: Buffer.from("empty-mime bytes"),
    filename: "blank.gif",
    mime: "",
    author: "me",
  });
  expect(b.mime).toBe("image/gif");
});

test("non-image types are rejected", () => {
  expect(() =>
    A.saveAttachment({ data: PNG, filename: "x.svg", author: "me" }),
  ).toThrowError(/extension/);
  expect(() =>
    A.saveAttachment({
      data: PNG,
      filename: "x.png",
      mime: "application/pdf",
      author: "me",
    }),
  ).toThrowError(/MIME/);
});

test("files over the size limit are rejected", () => {
  const big = Buffer.alloc(A.MAX_ATTACHMENT_BYTES + 1, 1);
  expect(() =>
    A.saveAttachment({ data: big, filename: "big.png", author: "me" }),
  ).toThrowError(/too large/);
});

test("empty files are rejected", () => {
  expect(() =>
    A.saveAttachment({
      data: Buffer.alloc(0),
      filename: "empty.png",
      author: "me",
    }),
  ).toThrowError(/Empty/);
});
