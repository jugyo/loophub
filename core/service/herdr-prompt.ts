import { isServiceError, ServiceError } from "../errors.ts";
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

// Bracketed paste (DEC 2004). `send-text` writes the body straight to the pane's PTY as plain
// bytes, so without these markers a coding agent's TUI has nothing but arrival timing to tell a
// paste from typing: it classifies the burst as a paste and swallows the `Enter` that follows a
// few milliseconds later into the pasted text, leaving the prompt sitting in the input box
// unsent (#2113/#2121/#2137). Splitting the delivery into two Herdr requests did not fix that —
// the two writes still reach the PTY ~7ms apart, well inside the TUI's paste window. The closing
// marker ends the paste in the terminal's own parser, so the `Enter` after it is a key press no
// matter how the bytes are batched.
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

// A prompt body carrying ESC could close its own paste region and turn the rest of the text into
// key presses, so the escape byte is dropped: prompts are text, and this is the only encoding
// they have to survive.
function pasted(text: string): string {
  return `${PASTE_START}${text.replaceAll("\u001b", "")}${PASTE_END}`;
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
  await paneRequest(delivery, "text", [
    "send-text",
    delivery.paneId,
    pasted(delivery.text),
  ]);
  await paneRequest(delivery, "submit", [
    "send-keys",
    delivery.paneId,
    "Enter",
  ]);
}
