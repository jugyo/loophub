// Attachment upload for a markdown <textarea>: paste, drag-drop, or a file picker.
// On a file it inserts a `[Uploading name…]()` placeholder at the cursor, uploads
// the bytes to POST /attachments, and swaps the placeholder for the returned
// markdown — `![](...)` for an image, `[](...)` for a document (or an error note on
// failure, e.g. when the server rejects an unsupported type). The body stays a
// controlled value owned by the caller — we only ever call `onChange` with the next
// string.

import { type ClipboardEvent, type DragEvent, useRef, useState } from "react";
import { uploadAttachment } from "@/api/attachments";

// Monotonic id so concurrent uploads get distinct, replaceable placeholder tokens.
let uploadSeq = 0;

export function useAttachmentUpload(opts: {
  value: string;
  onChange: (next: string) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  // Track the latest value across async uploads without re-binding handlers.
  const valueRef = useRef(opts.value);
  valueRef.current = opts.value;
  const [uploadingCount, setUploadingCount] = useState(0);

  function set(next: string) {
    valueRef.current = next;
    opts.onChange(next);
  }

  function insertAtCursor(text: string): void {
    const ta = opts.textareaRef.current;
    const v = valueRef.current;
    if (ta && ta.selectionStart != null) {
      const { selectionStart: start, selectionEnd: end } = ta;
      set(v.slice(0, start) + text + v.slice(end));
    } else {
      set(v + text);
    }
  }

  async function handleFiles(files: File[]): Promise<void> {
    for (const file of files) {
      const token = `[Uploading ${file.name}…](uploading:${++uploadSeq})`;
      insertAtCursor(`${token}\n`);
      setUploadingCount((n) => n + 1);
      try {
        const r = await uploadAttachment(file);
        // Function replacer: insert the markdown verbatim, so a filename with a
        // `$` sequence (e.g. `pic$1.png`) isn't treated as a replace pattern.
        set(valueRef.current.replace(token, () => r.markdown));
      } catch (e) {
        const why = e instanceof Error ? e.message : "error";
        set(valueRef.current.replace(token, () => `[upload failed: ${why}]()`));
      } finally {
        setUploadingCount((n) => n - 1);
      }
    }
  }

  return {
    uploading: uploadingCount > 0,
    /** Upload files chosen through a file picker. */
    upload(files: File[]) {
      if (files.length > 0) void handleFiles(files);
    },
    onPaste(e: ClipboardEvent<HTMLTextAreaElement>) {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void handleFiles(files);
      }
    },
    onDrop(e: DragEvent<HTMLTextAreaElement>) {
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length > 0) {
        e.preventDefault();
        void handleFiles(files);
      }
    },
    onDragOver(e: DragEvent<HTMLTextAreaElement>) {
      if (
        Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file")
      )
        e.preventDefault();
    },
  };
}
