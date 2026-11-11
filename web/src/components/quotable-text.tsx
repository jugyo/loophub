// Wraps a rendered comment body: selecting text inside it offers a "Quote" button near where the
// selection ended that hands the selected text to the comment form the body belongs to.

import { TextQuote } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Keep the button inside the wrapper when the selection ends near its right edge.
const QUOTE_BUTTON_WIDTH = 84;
const QUOTE_BUTTON_OFFSET = 34;
const QUOTE_BUTTON_GAP = 4;

// The quote goes in its own paragraph, leaving the caret on a fresh line below it.
export function appendQuote(body: string, selection: string): string {
  const quote = selection
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const existing = body.trimEnd();
  return `${existing ? `${existing}\n\n` : ""}${quote}\n\n`;
}

function compact(text: string): string {
  return text.replace(/\s/g, "");
}

export function QuotableText({
  onQuote,
  className,
  children,
}: {
  onQuote: (text: string) => void;
  className?: string;
  children: ReactNode;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  // The x the mouse released the selection at; null when the keyboard made the selection.
  const mouseRef = useRef<number | "pressed" | null>(null);
  const [quote, setQuote] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    function update() {
      // The selection is still changing while the mouse drags; offer Quote once it is released.
      const mouseX = mouseRef.current;
      if (mouseX === "pressed") {
        setQuote(null);
        return;
      }
      const box = boxRef.current;
      const selection = document.getSelection();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
      const text =
        box && range && box.contains(range.startContainer)
          ? selection?.toString().trim()
          : "";
      if (!box || !range || !text) {
        setQuote(null);
        return;
      }
      // A triple-click ends the range at the start of the next block, outside the body. That still
      // counts as inside as long as no text beyond the body is selected. Range text has no line
      // breaks between blocks, so the comparison ignores whitespace.
      const within = range.cloneRange();
      if (!box.contains(range.endContainer)) {
        within.setEnd(box, box.childNodes.length);
        if (compact(within.toString()) !== compact(text)) {
          setQuote(null);
          return;
        }
      }
      const selected = within.getBoundingClientRect();
      const outer = box.getBoundingClientRect();
      const above = selected.top - outer.top - QUOTE_BUTTON_OFFSET;
      // A mouse selection ends on its last line unless it was dragged upward, so the button goes on
      // the far side of that line to stay off the selected text.
      const backward =
        selection?.anchorNode === range.endContainer &&
        selection?.anchorOffset === range.endOffset;
      setQuote({
        text,
        top:
          mouseX === null || backward
            ? above
            : selected.bottom - outer.top + QUOTE_BUTTON_GAP,
        left: Math.max(
          0,
          Math.min(
            (mouseX ?? selected.left) - outer.left,
            outer.width - QUOTE_BUTTON_WIDTH,
          ),
        ),
      });
    }
    function onMouseDown(event: MouseEvent) {
      mouseRef.current = event.button === 0 ? "pressed" : null;
    }
    function onMouseUp(event: MouseEvent) {
      if (mouseRef.current !== "pressed") return;
      mouseRef.current = event.clientX;
      update();
    }
    function onKeyDown() {
      mouseRef.current = null;
    }
    document.addEventListener("selectionchange", update);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <div className={cn("relative", className)}>
      <div ref={boxRef}>{children}</div>
      {quote ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="absolute z-10 select-none border shadow-md"
          style={{ top: quote.top, left: quote.left }}
          // Pressing the button must not collapse the selection it acts on or count as a new one.
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={() => {
            document.getSelection()?.removeAllRanges();
            setQuote(null);
            onQuote(quote.text);
          }}
        >
          <TextQuote className="size-3.5" aria-hidden="true" />
          Quote
        </Button>
      ) : null}
    </div>
  );
}
