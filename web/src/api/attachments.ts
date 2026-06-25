// Image attachment upload. Unlike the JSON-RPC methods in ./client, uploads go to
// the dedicated binary route POST /attachments (the body is the image bytes). The
// response carries the stable url and the `![](...)` markdown to embed in a body.

import { getSessionId } from "@/lib/session";
import { API_BASE, ApiError } from "./client";

export interface UploadedAttachment {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
  markdown: string;
}

export async function uploadAttachment(
  file: File,
  actor: string = getSessionId(),
): Promise<UploadedAttachment> {
  const qs = new URLSearchParams({ filename: file.name, actor });
  const res = await fetch(`${API_BASE}/attachments?${qs}`, {
    method: "POST",
    headers: { "content-type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      message = ((await res.json()) as { error?: string }).error ?? message;
    } catch {
      // keep statusText
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as UploadedAttachment;
}
