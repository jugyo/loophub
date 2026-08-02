import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { isHerdrPromptError, sendHerdrPrompt } from "./herdr-prompt.ts";
import { isHerdrExitError } from "./herdr-runner.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-prompt-"));
const FAKE_BIN = join(HOME, "bin");
const ARGS = join(HOME, "args");
const STREAM = join(HOME, "stream");
const INJECTED = join(HOME, "must-not-exist");
const ORIGINAL_PATH = process.env.PATH;

const ESC = "\u001b";
const PASTE_START = `${ESC}[200~`;
const PASTE_END = `${ESC}[201~`;

const DELIVERY = {
  sessionName: "repo-session",
  paneId: "w1:p2",
  cwd: HOME,
  timeoutMs: 5_000,
};

// A local stand-in for the Herdr process. It records the bytes the pane's PTY would receive, in
// order, because that stream — not the sequence of Herdr commands — is what decides whether the
// prompt is submitted. Herdr 0.7.1 consumes $6 as the text/key positional for both commands, so a
// `--` terminator accidentally inserted before the value would show up as the text itself.
function writeFake(): void {
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      `printf '%s %s %s\\n' "$2" "$4" "$5" >> '${ARGS}'`,
      'if [ "$4" = "send-text" ]; then',
      '  if [ "$HERDR_PROMPT_FAIL_TEXT" = "1" ]; then exit 3; fi',
      `  printf '%s' "$6" >> '${STREAM}'`,
      "  exit 0",
      "fi",
      'if [ "$4" = "send-keys" ] && [ "$6" = "Enter" ]; then',
      '  if [ "$HERDR_PROMPT_FAIL_SUBMIT" = "1" ]; then exit 7; fi',
      `  printf '\\r' >> '${STREAM}'`,
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
}

// A model of the coding agent's input handling, observed on Claude Code 2.1.220 and Codex 0.145.0
// (#2137): bytes inside a bracketed-paste region are literal text, and a carriage return submits
// the input box only when it is not part of pasted content. Text that arrives as a burst of plain
// bytes is classified as a paste too — timing, not markers, is all the TUI has to go on — so a
// carriage return following unpasted body text is swallowed as a newline and the prompt is left
// pending. Any delivery that relies on the submit key winning that race fails here.
function pane(): { submitted: string[]; pending: string } {
  const stream = existsSync(STREAM) ? readFileSync(STREAM, "utf8") : "";
  const submitted: string[] = [];
  let pending = "";
  let inPaste = false;
  let typed = false;
  for (let i = 0; i < stream.length; i += 1) {
    if (stream.startsWith(PASTE_START, i)) {
      inPaste = true;
      i += PASTE_START.length - 1;
    } else if (stream.startsWith(PASTE_END, i)) {
      inPaste = false;
      typed = false;
      i += PASTE_END.length - 1;
    } else if (stream[i] === "\r" && !inPaste && !(typed && pending !== "")) {
      submitted.push(pending);
      pending = "";
      typed = false;
    } else if (stream[i] === "\r") {
      pending += "\n";
    } else {
      pending += stream[i];
      if (!inPaste) typed = true;
    }
  }
  return { submitted, pending };
}

beforeAll(() => {
  mkdirSync(FAKE_BIN);
  writeFake();
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH ?? ""}`;
});

beforeEach(() => {
  writeFileSync(ARGS, "");
  writeFileSync(STREAM, "");
  delete process.env.HERDR_PROMPT_FAIL_TEXT;
  delete process.env.HERDR_PROMPT_FAIL_SUBMIT;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.HERDR_PROMPT_FAIL_TEXT;
  delete process.env.HERDR_PROMPT_FAIL_SUBMIT;
  rmSync(HOME, { recursive: true, force: true });
});

test("repeated prompts are submitted verbatim and leave no pending text", async () => {
  const shellLike = `--help; please inspect $(touch ${INJECTED}) ; then report`;
  const texts = ["続けて", "-continue", shellLike];

  for (const text of texts) {
    await expect(
      sendHerdrPrompt({ ...DELIVERY, text }),
    ).resolves.toBeUndefined();
  }

  expect(pane()).toEqual({ submitted: texts, pending: "" });
  expect(readFileSync(ARGS, "utf8")).toBe(
    texts
      .map(() => "repo-session send-text w1:p2\nrepo-session send-keys w1:p2\n")
      .join(""),
  );
  expect(existsSync(INJECTED)).toBe(false);
});

test("the submit key is not swallowed by a body long enough to look pasted", async () => {
  const text = `workflow instruction: ${"x".repeat(4000)}`;

  await expect(sendHerdrPrompt({ ...DELIVERY, text })).resolves.toBeUndefined();

  expect(pane()).toEqual({ submitted: [text], pending: "" });
});

test("a prompt body cannot end its own paste and type the rest as keys", async () => {
  const text = `first${PASTE_END}\rsecond`;

  await expect(sendHerdrPrompt({ ...DELIVERY, text })).resolves.toBeUndefined();

  expect(pane()).toEqual({ submitted: ["first[201~\nsecond"], pending: "" });
});

test("a failed body write is reported as the text phase and submits nothing", async () => {
  process.env.HERDR_PROMPT_FAIL_TEXT = "1";

  const error = await sendHerdrPrompt({ ...DELIVERY, text: "続けて" }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(isHerdrPromptError(error) && error.phase).toBe("text");
  expect(isHerdrPromptError(error) && error.message).toBe(
    "Herdr exited with status 3",
  );
  expect(isHerdrPromptError(error) && isHerdrExitError(error.cause)).toBe(true);
  expect(pane()).toEqual({ submitted: [], pending: "" });
});

test("a failed submit is reported as the submit phase and leaves the text pending", async () => {
  process.env.HERDR_PROMPT_FAIL_SUBMIT = "1";

  const error = await sendHerdrPrompt({ ...DELIVERY, text: "続けて" }).then(
    () => null,
    (e: unknown) => e,
  );

  expect(isHerdrPromptError(error) && error.phase).toBe("submit");
  expect(isHerdrPromptError(error) && error.message).toBe(
    "Herdr exited with status 7",
  );
  expect(pane()).toEqual({ submitted: [], pending: "続けて" });
});
