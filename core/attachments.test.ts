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

test("saveAttachment stores a content-addressed blob and returns url + markdown", async () => {
  const r = await A.saveAttachment({
    data: PNG,
    filename: "shot.png",
    author: "me",
  });
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

test("saveAttachment stores HTML and returns a download link", async () => {
  const r = await A.saveAttachment({
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

  const duplicate = await A.saveAttachment({
    data: HTML,
    filename: "copy.htm",
    mime: "text/html",
    author: "you",
  });
  expect(duplicate.sha256).toBe(r.sha256);
  expect(duplicate.filename).toBe("report.html");
  expect(duplicate.author).toBe("me");
});

test("saveAttachment accepts the .htm extension and canonicalizes its MIME", async () => {
  const r = await A.saveAttachment({
    data: Buffer.from("<!doctype html><title>HTM</title>"),
    filename: "report.htm",
    mime: "text/html; charset=utf-8",
    author: "me",
  });
  expect(r.mime).toBe("text/html");
  expect(r.markdown).toBe(`[report.htm](/attachments/${r.sha256})`);
});

test("saveAttachment stores a Markdown document and returns a plain link", async () => {
  const doc = Buffer.from("# 調査結果\n\n- ひとつめ\n");
  const r = await A.saveAttachment({
    data: doc,
    filename: "findings.md",
    mime: "text/markdown",
    author: "me",
  });
  expect(r.mime).toBe("text/markdown");
  expect(r.markdown).toBe(`[findings.md](/attachments/${r.sha256})`);
  expect(readFileSync(A.blobPath(r.sha256)).equals(doc)).toBe(true);
});

test("saveAttachment stores plain text, trusting the extension when MIME is absent", async () => {
  const r = await A.saveAttachment({
    data: Buffer.from("plain notes"),
    filename: "notes.txt",
    author: "me",
  });
  expect(r.mime).toBe("text/plain");
  expect(r.markdown).toBe(`[notes.txt](/attachments/${r.sha256})`);
});

test("a document extension with a mismatched MIME is rejected", async () => {
  await expect(
    A.saveAttachment({
      data: Buffer.from("# doc"),
      filename: "doc.md",
      mime: "text/plain",
      author: "me",
    }),
  ).rejects.toThrowError(/does not match extension/);
});

test("parseAttachmentRef accepts a sha256, the URL path, and an absolute URL", () => {
  const sha = "a".repeat(64);
  expect(A.parseAttachmentRef(sha)).toBe(sha);
  expect(A.parseAttachmentRef(` /attachments/${sha} `)).toBe(sha);
  expect(A.parseAttachmentRef(`http://127.0.0.1:8730/attachments/${sha}`)).toBe(
    sha,
  );
  expect(A.parseAttachmentRef("/attachments/nope")).toBeNull();
  expect(A.parseAttachmentRef("")).toBeNull();
});

test("readAttachment returns the stored bytes, path and metadata", async () => {
  const doc = Buffer.from("# hand-off\n");
  const saved = await A.saveAttachment({
    data: doc,
    filename: "handoff.md",
    author: "me",
  });
  const r = await A.readAttachment(saved.url);
  expect(r.attachment.filename).toBe("handoff.md");
  expect(r.attachment.mime).toBe("text/markdown");
  expect(r.path).toBe(A.blobPath(saved.sha256));
  expect(r.data.equals(doc)).toBe(true);
  // Same result from the bare sha256.
  expect((await A.readAttachment(saved.sha256)).data.equals(doc)).toBe(true);

  await expect(A.readAttachment("not-a-ref")).rejects.toThrowError(
    /Not an attachment reference/,
  );
  await expect(A.readAttachment("0".repeat(64))).rejects.toThrowError(
    /not found/,
  );
});

test("re-uploading the same bytes converges on one blob and one row (dedup)", async () => {
  const a = await A.saveAttachment({
    data: PNG,
    filename: "a.png",
    author: "me",
  });
  const b = await A.saveAttachment({
    data: PNG,
    filename: "b.png",
    author: "you",
  });
  expect(b.sha256).toBe(a.sha256);
  // First write wins: filename/author from the original row are kept.
  expect(b.filename).toBe(a.filename);
  expect(b.author).toBe(a.author);
});

test("re-uploading the same bytes with a different MIME type is rejected", async () => {
  const imageFirst = Buffer.from("same bytes, image first");
  await A.saveAttachment({
    data: imageFirst,
    filename: "first.png",
    mime: "image/png",
    author: "me",
  });
  await expect(
    A.saveAttachment({
      data: imageFirst,
      filename: "second.html",
      mime: "text/html",
      author: "you",
    }),
  ).rejects.toThrowError(/does not match stored attachment MIME/);

  const htmlFirst = Buffer.from("same bytes, HTML first");
  await A.saveAttachment({
    data: htmlFirst,
    filename: "first.html",
    mime: "text/html",
    author: "me",
  });
  await expect(
    A.saveAttachment({
      data: htmlFirst,
      filename: "second.png",
      mime: "image/png",
      author: "you",
    }),
  ).rejects.toThrowError(/does not match stored attachment MIME/);
});

test("getAttachment returns stored metadata, null when missing", async () => {
  const a = await A.saveAttachment({
    data: PNG,
    filename: "g.png",
    author: "me",
  });
  expect(A.getAttachment(a.sha256)?.mime).toBe("image/png");
  expect(A.getAttachment("0".repeat(64))).toBeNull();
});

test("declared MIME and extension are validated and must agree", async () => {
  // jpg extension claiming png MIME is rejected.
  await expect(
    A.saveAttachment({
      data: PNG,
      filename: "x.jpg",
      mime: "image/png",
      author: "me",
    }),
  ).rejects.toThrowError(/does not match/);
  // jpeg extension + image/jpeg MIME is accepted (canonicalized). Use distinct
  // bytes so content-addressing doesn't dedup onto the earlier PNG row.
  const ok = await A.saveAttachment({
    data: Buffer.from("distinct jpeg bytes"),
    filename: "x.jpeg",
    mime: "image/jpeg",
    author: "me",
  });
  expect(ok.mime).toBe("image/jpeg");
});

test("empty / octet-stream MIME falls back to the extension (browser drop case)", async () => {
  // A browser that can't infer a dropped image's type sends application/octet-stream;
  // a valid extension must still be accepted and canonicalized.
  const a = await A.saveAttachment({
    data: Buffer.from("octet bytes"),
    filename: "drop.png",
    mime: "application/octet-stream",
    author: "me",
  });
  expect(a.mime).toBe("image/png");
  const b = await A.saveAttachment({
    data: Buffer.from("empty-mime bytes"),
    filename: "blank.gif",
    mime: "",
    author: "me",
  });
  expect(b.mime).toBe("image/gif");
});

test("non-image types are rejected", async () => {
  await expect(
    A.saveAttachment({ data: PNG, filename: "x.svg", author: "me" }),
  ).rejects.toThrowError(/extension/);
  await expect(
    A.saveAttachment({
      data: PNG,
      filename: "x.png",
      mime: "application/pdf",
      author: "me",
    }),
  ).rejects.toThrowError(/MIME/);
});

test("files over the size limit are rejected", async () => {
  const big = Buffer.alloc(A.MAX_ATTACHMENT_BYTES + 1, 1);
  await expect(
    A.saveAttachment({ data: big, filename: "big.png", author: "me" }),
  ).rejects.toThrowError(/too large/);
});

test("empty files are rejected", async () => {
  await expect(
    A.saveAttachment({
      data: Buffer.alloc(0),
      filename: "empty.png",
      author: "me",
    }),
  ).rejects.toThrowError(/Empty/);
});
