// Bracketed paste (DEC 2004). `herdr pane send-text` writes the body straight to the pane's PTY as
// plain bytes, so without these markers a coding agent's TUI has nothing but arrival timing to tell
// a paste from typing: it classifies the burst as a paste and swallows the `Enter` that follows a
// few milliseconds later into the pasted text, leaving the prompt sitting in the input box unsent
// (#2113/#2121/#2137). Splitting the delivery into two Herdr requests did not fix that — the two
// writes still reach the PTY ~7ms apart, well inside the TUI's paste window. The closing marker
// ends the paste in the terminal's own parser, so the `Enter` after it is a key press no matter how
// the bytes are batched.
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

// A prompt body carrying ESC could close its own paste region and turn the rest of the text into
// key presses, so the escape byte is dropped: prompts are text, and this is the only encoding they
// have to survive.
export function pastedText(text: string): string {
  return `${PASTE_START}${text.replaceAll("\u001b", "")}${PASTE_END}`;
}

// The two `herdr pane ...` argument lists that deliver one prompt: paste the body, then submit it.
// They are separate Herdr requests so a failed body write is reported without submitting whatever
// was already in the pane; correctness of the submit itself comes from the paste markers, not from
// the split. The text is passed as a literal argv positional — no shell, and no `--` terminator,
// which Herdr's `send-text` would send as the text itself — so `-`-leading and shell-like prompts
// arrive verbatim.
export function herdrPromptPaneArgs(
  paneId: string,
  text: string,
): { text: string[]; submit: string[] } {
  return {
    text: ["send-text", paneId, pastedText(text)],
    submit: ["send-keys", paneId, "Enter"],
  };
}
