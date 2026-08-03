// Shared modal chrome for full-size previews of Markdown-embedded content (images, Mermaid
// diagrams — see image-lightbox.tsx / mermaid-diagram.tsx). Follows the same role="dialog" +
// fixed inset-0 backdrop pattern as pull-debug-menu.tsx.
//
// Mouse-wheel zoom is exponential (multiplicative per tick) so it feels consistent regardless of
// current scale; scroll up zooms in, scroll down zooms out. Content is wrapped once here so the
// dialog chrome, focus trap, zoom state, and drag-to-pan behavior stay shared.
//
// Wheel zoom is wired via a native, non-passive listener (not React's onWheel): React registers
// "wheel" as passive by default (see react-dom's addTrappedEventListener), so e.preventDefault()
// inside a React onWheel handler is silently ignored and the page behind the dialog would still
// scroll. Escape is handled as a React onKeyDown on the focused dialog element rather than a
// document-level listener, so it doesn't also trigger an ancestor's own document Escape listener
// when nested inside another modal that listens on document. The overlay is portaled to the
// document body so nested Markdown previews cannot constrain it with their overflow or layout.

import { X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";

const MIN_SCALE = 1;
const MAX_SCALE = 6;
const WHEEL_ZOOM_SENSITIVITY = 0.0015;
const ZERO_PAN = { x: 0, y: 0 };

type Pan = {
  x: number;
  y: number;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function panBounds(
  dialog: HTMLDivElement | null,
  content: HTMLDivElement | null,
  scale: number,
) {
  if (scale <= MIN_SCALE) return { x: 0, y: 0 };

  const contentRect = content?.getBoundingClientRect();
  const viewportWidth = dialog?.clientWidth ?? 0;
  const viewportHeight = dialog?.clientHeight ?? 0;

  if (
    !content ||
    !contentRect ||
    contentRect.width === 0 ||
    contentRect.height === 0 ||
    viewportWidth === 0 ||
    viewportHeight === 0
  ) {
    return { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY };
  }

  const width = content.offsetWidth || contentRect.width / scale;
  const height = content.offsetHeight || contentRect.height / scale;
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;

  return {
    x: Math.max(0, (scaledWidth - viewportWidth) / 2),
    y: Math.max(0, (scaledHeight - viewportHeight) / 2),
  };
}

function clampPan(
  pan: Pan,
  dialog: HTMLDivElement | null,
  content: HTMLDivElement | null,
  scale: number,
): Pan {
  const bounds = panBounds(dialog, content, scale);
  return {
    x: clamp(pan.x, -bounds.x, bounds.x),
    y: clamp(pan.y, -bounds.y, bounds.y),
  };
}

export function Lightbox({
  ariaLabel,
  onClose,
  children,
}: {
  ariaLabel: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState<Pan>(ZERO_PAN);
  const [dragStart, setDragStart] = useState<{
    pointer: Pan;
    pan: Pan;
  } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const suppressNextClickRef = useRef(false);
  // The close button is the dialog's only focusable descendant, so Tab/Shift+Tab both trap
  // focus on it — without this, Tab moves focus past the (non-portaled) overlay into the
  // underlying page, after which this dialog's own Escape handler stops receiving keydowns.
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

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
        const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next));
        setPan((p) =>
          nextScale <= MIN_SCALE
            ? ZERO_PAN
            : clampPan(p, dialogRef.current, contentRef.current, nextScale),
        );
        return nextScale;
      });
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    if (!dragStart) return;
    const start = dragStart;

    function onMouseMove(e: MouseEvent) {
      setPan(
        clampPan(
          {
            x: start.pan.x + e.clientX - start.pointer.x,
            y: start.pan.y + e.clientY - start.pointer.y,
          },
          dialogRef.current,
          contentRef.current,
          scale,
        ),
      );
    }

    function onMouseUp() {
      setDragStart(null);
    }

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragStart, scale]);

  return createPortal(
    <div
      ref={dialogRef}
      data-debug-component="Lightbox"
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-auto bg-black/80 p-4 outline-none"
      {...backdropDismiss}
      onClick={(event) => {
        if (suppressNextClickRef.current) {
          suppressNextClickRef.current = false;
          backdropDismiss.onClick(event);
          return;
        }
        backdropDismiss.onClick(event);
      }}
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
      <div
        ref={contentRef}
        className={
          scale > MIN_SCALE ? "cursor-grab active:cursor-grabbing" : ""
        }
        style={{
          transform: `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})`,
        }}
        onClick={(e) => {
          suppressNextClickRef.current = false;
          e.stopPropagation();
        }}
        onMouseDown={(e) => {
          e.stopPropagation();
          if (scale <= MIN_SCALE || e.button !== 0) return;
          e.preventDefault();
          suppressNextClickRef.current = true;
          setDragStart({
            pointer: { x: e.clientX, y: e.clientY },
            pan,
          });
        }}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
