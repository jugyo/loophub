// "New issue" button + guidance modal. Issues are created by an AI (Claude Code
// etc.) via the /loophub-issue-create skill, not by hand — so instead of a real
// form, the dialog lets the user describe what they want and hands back a ready
// Claude command to paste into their agent.
// The backend create API (useCreateIssue) stays for the skill/CLI to use.

import { useEffect, useState } from "react";
import { Plus, Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";

export function CreateIssueButton() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="size-4" />
        New issue
      </Button>
      {open ? <CreateIssueGuideDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

// Build the Claude command from the user's intent. The intent goes inside a
// double-quoted shell argument, so escape the characters that are special in
// that context (\ " $ `) — otherwise a quote or `$()`/backtick in the intent
// would break out of the argument when the command is pasted into a terminal.
function buildCommand(text: string): string {
  const escaped = text.trim().replace(/[\\"$`]/g, "\\$&");
  return `claude "/loophub-issue-create ${escaped}"`;
}

function CreateIssueGuideDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");
  const [copied, setCopied] = useState(false);

  // Close on Escape, mirroring native dialog dismissal.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const command = buildCommand(text);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard may be unavailable (e.g. non-secure context); ignore.
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="New issue"
        className="flex max-h-[88vh] w-full max-w-xl flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">New issue</h2>
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto text-sm">
          <div className="flex flex-col gap-2">
            <label htmlFor="issue-intent" className="font-medium">
              What do you want to do?
            </label>
            {/* Sized to comfortably show a short paragraph (~400 chars); the
                length is not capped. */}
            <textarea
              id="issue-intent"
              autoFocus
              rows={6}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Describe what you want to build or fix, in your own words."
              className="min-h-[8rem] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>

          {text.trim() ? (
            <div className="flex flex-col gap-2">
              <p className="font-medium">Run this in your terminal</p>
              <div className="relative">
                <pre className="min-h-[3.5rem] overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-muted px-3 py-2 pr-10 font-mono text-xs">
                  {command}
                </pre>
                <button
                  type="button"
                  onClick={copy}
                  aria-label="Copy command"
                  className="absolute right-2 top-2 rounded-md p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </button>
              </div>
              <p className="text-muted-foreground">
                The AI checks for duplicates, shapes the Goal and acceptance
                criteria, then files the issue and returns its number and URL.
              </p>
            </div>
          ) : null}
        </div>
        <div className="mt-4 flex justify-end">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </div>
  );
}
