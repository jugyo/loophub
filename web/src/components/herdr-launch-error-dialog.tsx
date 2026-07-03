// Overlay dialog for a failed Herdr launch (#483). Replaces the generic error toast for
// this specific failure with a dialog carrying the actual reason plus the exact `herdr` command
// the user can re-run locally to see the full output themselves (the server deliberately never
// forwards raw stdout/stderr — see the comment on runHerdrLaunch in core/service.ts). Follows the
// same role="dialog" + fixed inset-0 backdrop pattern as markdown-preview-modal.tsx.

import { AlertTriangle, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export interface HerdrLaunchError {
  reason: string;
  command?: string;
  // The Herdr session this launch targeted — shown so first-time Herdr users can create that
  // session before retrying (`agent start` only works against an already-running session; it does
  // not create one, unlike the bare `herdr --session <name>` form).
  session?: string;
}

function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-md border bg-muted p-2">
      <code className="min-w-0 flex-1 break-all font-mono text-xs">
        {command}
      </code>
      <button
        type="button"
        className="shrink-0 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        onClick={() => {
          navigator.clipboard?.writeText(command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export function HerdrLaunchErrorDialog({
  error,
  onClose,
}: {
  error: HerdrLaunchError;
  onClose: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Herdr launch failed"
        className="flex w-full max-w-lg flex-col rounded-lg border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-destructive">
            <AlertTriangle className="size-4 shrink-0" />
            Herdr launch failed
          </h2>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </header>
        <div className="flex flex-col gap-4 p-4 text-sm">
          <p className="break-words">{error.reason}</p>

          {error.session ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                If the session doesn't exist yet, create it first, then retry:
              </span>
              <CopyableCommand command={`herdr --session ${error.session}`} />
            </div>
          ) : null}

          {error.command ? (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">
                Try it yourself in a terminal:
              </span>
              <CopyableCommand command={error.command} />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
