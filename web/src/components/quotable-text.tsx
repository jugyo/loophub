// Wraps a rendered comment body: selecting text inside it offers a "Quote" button near the selection
// that hands the selected text to the comment form the body belongs to.

import { TextQuote } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Keep the button inside the wrapper when the selection starts near its right edge.
const QUOTE_BUTTON_WIDTH = 80;
const QUOTE_BUTTON_OFFSET = 34;

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
  const [quote, setQuote] = useState<{
    text: string;
    top: number;
    left: number;
  } | null>(null);

  useEffect(() => {
    function update() {
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
      setQuote({
        text,
        top: selected.top - outer.top - QUOTE_BUTTON_OFFSET,
        left: Math.min(
          selected.left - outer.left,
          outer.width - QUOTE_BUTTON_WIDTH,
        ),
      });
    }
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
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
          // Pressing the button must not collapse the selection it acts on.
          onMouseDown={(event) => event.preventDefault()}
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
