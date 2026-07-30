import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { herdrAgentControl } from "./herdr-agent-control.ts";

const HOME = mkdtempSync(join(tmpdir(), "lh-herdr-agent-control-"));
const BIN_PATH = join(HOME, "bin");
const LOG_PATH = join(HOME, "herdr.log");
const ORIGINAL_PATH = process.env.PATH;
const TARGET = {
  provider: "herdr",
  targetId: "w1:p2",
  context: "repo-session",
};

beforeAll(() => {
  mkdirSync(BIN_PATH);
  const herdr = join(BIN_PATH, "herdr");
  writeFileSync(
    herdr,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$HERDR_AGENT_CONTROL_LOG"
if [ "$HERDR_AGENT_CONTROL_FAIL_SUBMIT" = "1" ] && printf '%s' "$*" | grep -q 'pane send-keys'; then
  exit 7
fi
`,
  );
  chmodSync(herdr, 0o755);
  process.env.PATH = `${BIN_PATH}:${ORIGINAL_PATH ?? ""}`;
  process.env.HERDR_AGENT_CONTROL_LOG = LOG_PATH;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.HERDR_AGENT_CONTROL_LOG;
  delete process.env.HERDR_AGENT_CONTROL_FAIL_SUBMIT;
  rmSync(HOME, { recursive: true, force: true });
});

test("inputText sends literal text and submits it in separate requests", async () => {
  const control = herdrAgentControl(HOME);

  await control.inputText(TARGET, "-continue");

  expect(readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean)).toEqual([
    "--session repo-session pane send-text w1:p2 -continue",
    "--session repo-session pane send-keys w1:p2 Enter",
  ]);

  process.env.HERDR_AGENT_CONTROL_FAIL_SUBMIT = "1";
  await expect(control.inputText(TARGET, "retry")).rejects.toThrowError(
    "Herdr exited with status 7",
  );
  expect(readFileSync(LOG_PATH, "utf8").split("\n").filter(Boolean)).toEqual([
    "--session repo-session pane send-text w1:p2 -continue",
    "--session repo-session pane send-keys w1:p2 Enter",
    "--session repo-session pane send-text w1:p2 retry",
    "--session repo-session pane send-keys w1:p2 Enter",
  ]);
});
