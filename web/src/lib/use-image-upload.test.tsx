import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import * as attach from "@/api/attachments";
import { useImageUpload } from "./use-image-upload";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// Minimal harness: a controlled textarea wired to the hook, like the comment form.
function Harness() {
  const [body, setBody] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const img = useImageUpload({
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
        onPaste={img.onPaste}
        onDrop={img.onDrop}
      />
      <span data-testid="uploading">{img.uploading ? "yes" : "no"}</span>
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
  expect(ta.value).toContain("![Uploading pic.png…]");

  // After upload resolves, the placeholder is replaced by the real embed markdown.
  await waitFor(() =>
    expect(ta.value).toBe(`![pic.png](/attachments/${"a".repeat(64)})\n`),
  );
  expect(spy).toHaveBeenCalledOnce();
});

test("a failed upload replaces the placeholder with an error note", async () => {
  vi.spyOn(attach, "uploadAttachment").mockRejectedValue(
    new Error("Image too large"),
  );

  const { getByLabelText } = render(<Harness />);
  const ta = getByLabelText("b") as HTMLTextAreaElement;

  fireEvent.drop(ta, { dataTransfer: { files: [pngFile()], items: [] } });

  await waitFor(() =>
    expect(ta.value).toContain("![upload failed: Image too large]()"),
  );
});

test("non-image pastes are ignored (no upload)", () => {
  const spy = vi.spyOn(attach, "uploadAttachment");
  const { getByLabelText } = render(<Harness />);
  const ta = getByLabelText("b") as HTMLTextAreaElement;
  const txt = new File(["hi"], "note.txt", { type: "text/plain" });
  fireEvent.paste(ta, { clipboardData: { files: [txt], items: [] } });
  expect(spy).not.toHaveBeenCalled();
  expect(ta.value).toBe("");
});
