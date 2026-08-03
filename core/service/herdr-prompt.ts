import { isServiceError, ServiceError } from "../errors.ts";
import { herdrPromptPaneArgs } from "../terminal/herdr-paste.ts";
import { runHerdr } from "./herdr-runner.ts";

// Which half of the delivery failed. A coding agent's prompt box keeps whatever `send-text`
// wrote, so "text" means nothing reached the input while "submit" means the text is sitting
// there unsent — callers surface that difference instead of one ambiguous failure.
export type HerdrPromptPhase = "text" | "submit";

export class HerdrPromptError extends ServiceError {
  readonly phase: HerdrPromptPhase;

  constructor(phase: HerdrPromptPhase, cause: unknown) {
    // Carry the underlying Herdr failure through unchanged: callers that simply propagate
    // (agent control, Workflow instructions) keep reporting the subprocess error they always
    // did, and only the callers that map by phase read `phase`.
    super(
      isServiceError(cause) ? cause.status : 500,
      cause instanceof Error ? cause.message : String(cause),
    );
    this.name = "HerdrPromptError";
    this.phase = phase;
    this.cause = cause;
  }
}

export function isHerdrPromptError(error: unknown): error is HerdrPromptError {
  return error instanceof HerdrPromptError;
}

export interface HerdrPromptDelivery {
  sessionName: string;
  paneId: string;
  text: string;
  cwd: string;
  timeoutMs: number;
}

function paneRequest(
  delivery: HerdrPromptDelivery,
  phase: HerdrPromptPhase,
  args: string[],
): Promise<unknown> {
  return runHerdr(
    "herdr",
    ["--session", delivery.sessionName, "pane", ...args],
    delivery.cwd,
    { timeoutMs: delivery.timeoutMs },
  ).catch((error: unknown) => {
    throw new HerdrPromptError(phase, error);
  });
}

// Delivers one prompt to a Herdr pane: paste the body, then submit it. The two steps are
// separate Herdr requests so a failed body write is reported without submitting whatever was
// already in the pane; correctness of the submit itself comes from the paste markers, not from
// the split. The text is passed as a literal argv positional — no shell, and no `--` terminator,
// which Herdr's `send-text` would send as the text itself — so `-`-leading and shell-like
// prompts arrive verbatim.
export async function sendHerdrPrompt(
  delivery: HerdrPromptDelivery,
): Promise<void> {
  const args = herdrPromptPaneArgs(delivery.paneId, delivery.text);
  await paneRequest(delivery, "text", args.text);
  await paneRequest(delivery, "submit", args.submit);
}
