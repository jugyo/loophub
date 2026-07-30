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
const PENDING = join(HOME, "pending");
const DELIVERED = join(HOME, "delivered");
const INJECTED = join(HOME, "must-not-exist");
const ORIGINAL_PATH = process.env.PATH;

const DELIVERY = {
  sessionName: "repo-session",
  paneId: "w1:p2",
  cwd: HOME,
  timeoutMs: 5_000,
};

function pending(): string {
  return readFileSync(PENDING, "utf8");
}

function delivered(): string {
  return readFileSync(DELIVERED).toString();
}

// A local stand-in for the Herdr process that models the pane's input state rather than a
// command log: `send-text` writes the pending prompt body, and only `Enter` moves it out as a
// delivered message. Herdr 0.7.1 consumes $6 as the text/key positional for both commands, so a
// `--` terminator accidentally inserted before the value would show up as the text itself.
function writeFake(): void {
  writeFileSync(
    join(FAKE_BIN, "herdr"),
    [
      "#!/bin/sh",
      'if [ "$4" = "send-text" ]; then',
      '  if [ "$HERDR_PROMPT_FAIL_TEXT" = "1" ]; then exit 3; fi',
      `  printf '%s|%s|%s' "$2" "$5" "$6" > '${PENDING}'`,
      "  exit 0",
      "fi",
      'if [ "$4" = "send-keys" ] && [ "$6" = "Enter" ]; then',
      '  if [ "$HERDR_PROMPT_FAIL_SUBMIT" = "1" ]; then exit 7; fi',
      `  cat '${PENDING}' >> '${DELIVERED}'`,
      `  printf '\\0' >> '${DELIVERED}'`,
      `  : > '${PENDING}'`,
      "  exit 0",
      "fi",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(join(FAKE_BIN, "herdr"), 0o755);
}

beforeAll(() => {
  mkdirSync(FAKE_BIN);
  writeFake();
  process.env.PATH = `${FAKE_BIN}:${ORIGINAL_PATH ?? ""}`;
});

beforeEach(() => {
  writeFileSync(PENDING, "");
  writeFileSync(DELIVERED, "");
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

  for (const text of ["続けて", "-continue", shellLike]) {
    await expect(
      sendHerdrPrompt({ ...DELIVERY, text }),
    ).resolves.toBeUndefined();
  }

  expect(pending()).toBe("");
  expect(delivered()).toBe(
    ["続けて", "-continue", shellLike]
      .map((text) => `repo-session|w1:p2|${text}\0`)
      .join(""),
  );
  expect(existsSync(INJECTED)).toBe(false);
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
  expect(pending()).toBe("");
  expect(delivered()).toBe("");
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
  expect(pending()).toBe("repo-session|w1:p2|続けて");
  expect(delivered()).toBe("");
});
