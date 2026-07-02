// Full-size image lightbox for images embedded in Markdown bodies (#471). Follows the same
// role="dialog" + fixed inset-0 backdrop pattern as markdown-preview-modal.tsx / pull-debug-menu.tsx.
// Mouse-wheel zoom is exponential (multiplicative per tick) so it feels consistent regardless of
// current scale; scroll up zooms in, scroll down zooms out.
//
// Wheel zoom is wired via a native, non-passive listener (not React's onWheel): React registers
// "wheel" as passive by default (see react-dom's addTrappedEventListener), so e.preventDefault()
// inside a React onWheel handler is silently ignored and the page behind the dialog would still
// scroll. Escape is handled as a React onKeyDown on the focused dialog element rather than a
// document-level listener, so it doesn't also trigger an ancestor's own document Escape listener
// (e.g. this lightbox can be opened from inside <MarkdownPreviewModal>, which listens on document).

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;

export function ImageLightbox({
  src,
  alt,
  onClose,
}: {
  src: string;
  alt: string;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const dialogRef = useRef<HTMLDivElement>(null);
  // The close button is the dialog's only focusable descendant, so Tab/Shift+Tab both trap
  // focus on it — without this, Tab moves focus past the (non-portaled) overlay into the
  // underlying page, after which this dialog's own Escape handler stops receiving keydowns.
  const closeButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      e.preventDefault();
      setScale((s) => {
        const next = s * (1 - e.deltaY * WHEEL_ZOOM_SENSITIVITY);
        return Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Image preview"}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/80 p-4 outline-none"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        } else if (e.key === "Tab") {
          e.preventDefault();
          closeButtonRef.current?.focus();
        }
      }}
    >
      <Button
        ref={closeButtonRef}
        variant="ghost"
        size="icon"
        aria-label="Close preview"
        className="fixed top-4 right-4 text-white hover:bg-white/10 hover:text-white"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="size-5" />
      </Button>
      <img
        src={src}
        alt={alt}
        className="max-h-[90vh] max-w-[90vw] select-none rounded object-contain shadow-2xl"
        style={{ transform: `scale(${scale})` }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
