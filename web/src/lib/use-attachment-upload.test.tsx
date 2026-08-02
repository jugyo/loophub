import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import * as attach from "@/api/attachments";
import { useAttachmentUpload } from "./use-attachment-upload";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Minimal harness: a controlled textarea wired to the hook, like the comment form.
function Harness() {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const upload = useAttachmentUpload({
    value: body,
    onChange: setBody,
    textareaRef: ref,
  });
  return (
    <>
      <textarea
        aria-label="b"
        ref={ref}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onPaste={upload.onPaste}
        onDrop={upload.onDrop}
      />
      <input
        aria-label="picker"
        type="file"
        onChange={(e) => upload.upload(Array.from(e.target.files ?? []))}
      />
      <span data-testid="uploading">{upload.uploading ? "yes" : "no"}</span>
    </>
  );
}

function pngFile(name = "pic.png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
}

test("pasting an image inserts a placeholder, then swaps in the returned markdown", async () => {
  const spy = vi.spyOn(attach, "uploadAttachment").mockResolvedValue({
    sha256: "a".repeat(64),
    filename: "pic.png",
    mime: "image/png",
    size: 3,
    url: `/attachments/${"a".repeat(64)}`,
    markdown: `![pic.png](/attachments/${"a".repeat(64)})`,
  });

  const { getByLabelText } = render(<Harness />);
  const ta = getByLabelText("b") as HTMLTextAreaElement;

  fireEvent.paste(ta, { clipboardData: { files: [pngFile()], items: [] } });

  // Optimistic placeholder appears immediately.
  expect(ta.value).toContain("[Uploading pic.png…]");

  // After upload resolves, the placeholder is replaced by the real embed markdown.
  await waitFor(() =>
    expect(ta.value).toBe(`![pic.png](/attachments/${"a".repeat(64)})\n`),
  );
  expect(spy).toHaveBeenCalledOnce();
});

test("dropping a document uploads it and inserts a plain link", async () => {
  vi.spyOn(attach, "uploadAttachment").mockResolvedValue({
    sha256: "b".repeat(64),
    filename: "findings.md",
    mime: "text/markdown",
    size: 7,
    url: `/attachments/${"b".repeat(64)}`,
    markdown: `[findings.md](/attachments/${"b".repeat(64)})`,
  });

  const { getByLabelText } = render(<Harness />);
  const ta = getByLabelText("b") as HTMLTextAreaElement;
  const md = new File(["# notes"], "findings.md", { type: "text/markdown" });

  fireEvent.drop(ta, { dataTransfer: { files: [md], items: [] } });

  await waitFor(() =>
    expect(ta.value).toBe(`[findings.md](/attachments/${"b".repeat(64)})\n`),
  );
});

test("files chosen through a picker are uploaded too", async () => {
  const spy = vi.spyOn(attach, "uploadAttachment").mockResolvedValue({
    sha256: "c".repeat(64),
    filename: "notes.txt",
    mime: "text/plain",
    size: 2,
    url: `/attachments/${"c".repeat(64)}`,
    markdown: `[notes.txt](/attachments/${"c".repeat(64)})`,
  });

  const { getByLabelText } = render(<Harness />);
  const picker = getByLabelText("picker") as HTMLInputElement;
  const ta = getByLabelText("b") as HTMLTextAreaElement;

  fireEvent.change(picker, {
    target: { files: [new File(["hi"], "notes.txt", { type: "text/plain" })] },
  });

  await waitFor(() =>
    expect(ta.value).toBe(`[notes.txt](/attachments/${"c".repeat(64)})\n`),
  );
  expect(spy).toHaveBeenCalledOnce();
});

test("a failed upload replaces the placeholder with an error note", async () => {
  vi.spyOn(attach, "uploadAttachment").mockRejectedValue(
    new Error("Unsupported attachment extension: .pdf"),
  );

  const { getByLabelText } = render(<Harness />);
  const ta = getByLabelText("b") as HTMLTextAreaElement;

  fireEvent.drop(ta, { dataTransfer: { files: [pngFile()], items: [] } });

  await waitFor(() =>
    expect(ta.value).toContain(
      "[upload failed: Unsupported attachment extension: .pdf]()",
    ),
  );
});

test("a paste carrying no files is left to the textarea (no upload)", () => {
  const spy = vi.spyOn(attach, "uploadAttachment");
  const { getByLabelText } = render(<Harness />);
  const ta = getByLabelText("b") as HTMLTextAreaElement;
  fireEvent.paste(ta, { clipboardData: { files: [], items: [] } });
  expect(spy).not.toHaveBeenCalled();
  expect(ta.value).toBe("");
});
