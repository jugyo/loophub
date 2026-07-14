// Standalone attachments. An attachment is a content-addressed blob
// stored under $LOOPHUB_HOME/attachments/<sha256[0:2]>/<sha256> with metadata in
// the `attachments` table. It is not linked to any repo/issue/PR — the sha256 is
// the identity and the URL (/attachments/<sha256>), referenced from markdown
// bodies as image embeds or file links. Blobs are immutable, dedup by content,
// and never garbage-collected.
//
// Both the HTTP upload route (web/server/http.ts) and the CLI (`lh attachment
// add`) call saveAttachment directly, so validation lives here, transport-neutral
// (throwing ServiceError with an HTTP-style status), mirroring core/service.ts.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { configDir } from "./config.ts";
import { db, now } from "./db.ts";
import { ServiceError } from "./errors.ts";

// One blob may not exceed 10MB.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Allowed attachment types: extension -> canonical MIME. Both the extension and the
// declared MIME are validated (and must agree) before a blob is stored.
const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".html": "text/html",
  ".htm": "text/html",
};
const ALLOWED_MIME = new Set(Object.values(EXT_TO_MIME));

export interface Attachment {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  author: string;
  created_at: string;
}

export interface UploadedAttachment extends Attachment {
  url: string;
  markdown: string;
}

export function attachmentsDir(): string {
  return join(configDir(), "attachments");
}

/** On-disk path of a blob: $LOOPHUB_HOME/attachments/<sha256[0:2]>/<sha256>. */
export function blobPath(sha256: string): string {
  return join(attachmentsDir(), sha256.slice(0, 2), sha256);
}

/** Stable URL for an attachment blob. */
export function attachmentUrl(sha256: string): string {
  return `/attachments/${sha256}`;
}

/** Markdown embed or link for an attachment. The label is sanitized so it
 * cannot break out of the `[...]` syntax. */
export function attachmentMarkdown(
  filename: string,
  sha256: string,
  mime: string,
): string {
  const label = filename.replace(/[[\]\r\n]/g, " ").trim() || "attachment";
  const prefix = mime.startsWith("image/") ? "!" : "";
  return `${prefix}[${label}](${attachmentUrl(sha256)})`;
}

// Validate filename extension + declared MIME, returning the canonical MIME.
function resolveMime(filename: string, declaredMime: string | null): string {
  const ext = extname(filename).toLowerCase();
  const extMime = EXT_TO_MIME[ext];
  if (!extMime) {
    throw new ServiceError(
      415,
      `Unsupported attachment extension: ${ext || "(none)"}`,
    );
  }
  const mime = declaredMime?.toLowerCase().split(";")[0].trim();
  // Browsers can't always infer a dropped/pasted image's type and send an empty
  // or octet-stream content-type; treat that as "unspecified" and trust the
  // (already-validated) extension rather than rejecting a valid image.
  if (mime && mime !== "application/octet-stream") {
    if (!ALLOWED_MIME.has(mime)) {
      throw new ServiceError(415, `Unsupported MIME type: ${declaredMime}`);
    }
    if (mime !== extMime) {
      throw new ServiceError(
        415,
        `MIME ${mime} does not match extension ${ext}`,
      );
    }
  }
  return extMime;
}

export function getAttachment(sha256: string): Attachment | null {
  return db
    .query("SELECT * FROM attachments WHERE sha256 = ?")
    .get(sha256) as Attachment | null;
}

/**
 * Validate and store an attachment blob, deduping by content. Re-uploading the same
 * bytes converges on one blob and one row (the original row is kept). Returns the
 * stored metadata plus the embed `url` and `markdown`.
 */
export function saveAttachment(input: {
  data: Buffer;
  filename: string;
  mime?: string | null;
  author: string;
}): UploadedAttachment {
  const size = input.data.length;
  if (size === 0) throw new ServiceError(400, "Empty file");
  if (size > MAX_ATTACHMENT_BYTES) {
    throw new ServiceError(
      413,
      `Attachment too large: ${size} bytes (max ${MAX_ATTACHMENT_BYTES})`,
    );
  }
  const mime = resolveMime(input.filename, input.mime ?? null);

  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const path = blobPath(sha256);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, input.data);
  }

  // Keep the first row on re-upload so created_at/author/filename stay stable.
  db.run(
    `INSERT INTO attachments (sha256, filename, mime, size, author, created_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`,
    [sha256, input.filename, mime, size, input.author, now()],
  );

  const row = getAttachment(sha256) as Attachment;
  if (row.mime !== mime) {
    throw new ServiceError(
      415,
      `MIME ${mime} does not match stored attachment MIME ${row.mime}`,
    );
  }
  return {
    ...row,
    url: attachmentUrl(sha256),
    markdown: attachmentMarkdown(row.filename, sha256, row.mime),
  };
}
