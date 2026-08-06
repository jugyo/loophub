// Shared read-only prompt preview dialog chrome. Used by Workflows "System prompt" and Settings
// → Pull requests "Preview prompt": same backdrop, header + Close, pre body, Escape / backdrop
// dismiss, and initial focus. Callers only swap title, description, content source, and labels.

import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { trapDialogFocus } from "@/lib/trap-dialog-focus";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";

export function ReadOnlyPromptDialog({
  title,
  description,
  content,
  loading = false,
  error = false,
  errorMessage = "Failed to load the system prompt.",
  closeAriaLabel,
  debugComponent = "ReadOnlyPromptDialog",
  onClose,
}: {
  title: string;
  description: string;
  content?: string;
  loading?: boolean;
  error?: boolean;
  errorMessage?: string;
  closeAriaLabel: string;
  debugComponent?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropDismiss = useBackdropDismiss(onClose);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("[data-dialog-initial-focus]")
      ?.focus();
    return () => previouslyFocused?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/50 p-4"
      {...backdropDismiss}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape") onClose();
      }}
    >
      <div
        ref={dialogRef}
        data-debug-component={debugComponent}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex w-full max-w-4xl flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(event) => trapDialogFocus(event, event.currentTarget)}
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={closeAriaLabel}
            data-dialog-initial-focus
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{errorMessage}</p>
          ) : (
            <pre className="whitespace-pre-wrap break-words rounded-md bg-muted/40 p-4 font-mono text-xs leading-relaxed">
              {content ?? ""}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
