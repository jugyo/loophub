import { Check, Loader2, Send } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSendHerdrAgentInput } from "@/queries/terminal";

export function HerdrAgentInput({
  repo,
  pull,
  paneId,
  className,
}: {
  repo: string;
  pull: number;
  paneId: string;
  className?: string;
}) {
  const sendInput = useSendHerdrAgentInput();
  const [text, setText] = useState("");
  const [feedback, setFeedback] = useState<
    { kind: "success" | "error"; message: string } | undefined
  >();
  const canSend = text.trim() !== "" && !sendInput.isPending;

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    setFeedback(undefined);
    sendInput.mutate(
      { repo, pull, paneId, text },
      {
        onSuccess: () => {
          setText("");
          setFeedback({ kind: "success", message: "Sent" });
        },
        onError: (error) =>
          setFeedback({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Failed to send input to Herdr.",
          }),
      },
    );
  }

  return (
    <form
      data-debug-component="HerdrAgentInput"
      onSubmit={submit}
      className={cn("flex min-w-0 flex-col gap-1.5", className)}
    >
      <div className="flex min-w-0 gap-2">
        <input
          type="text"
          aria-label={`Message agent for PR #${pull}`}
          placeholder="Send a follow-up instruction…"
          value={text}
          disabled={sendInput.isPending}
          onChange={(event) => {
            setText(event.target.value);
            setFeedback(undefined);
          }}
          className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button
          type="submit"
          size="sm"
          className="h-8 shrink-0"
          disabled={!canSend}
          aria-label={`Send message to agent for PR #${pull}`}
        >
          {sendInput.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Send className="size-3.5" />
          )}
          Send
        </Button>
      </div>
      {feedback ? (
        <p
          role={feedback.kind === "error" ? "alert" : "status"}
          className={cn(
            "flex items-center gap-1 text-xs",
            feedback.kind === "error"
              ? "text-destructive"
              : "text-green-600 dark:text-green-400",
          )}
        >
          {feedback.kind === "success" ? <Check className="size-3" /> : null}
          {feedback.message}
        </p>
      ) : null}
    </form>
  );
}
