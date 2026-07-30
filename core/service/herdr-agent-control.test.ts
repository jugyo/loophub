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
const DELIVERED_PATH = join(HOME, "delivered");
const ORIGINAL_PATH = process.env.PATH;
const TARGET = {
  provider: "herdr",
  targetId: "w1:p2",
  context: "repo-session",
};

beforeAll(() => {
  mkdirSync(BIN_PATH);
  const herdr = join(BIN_PATH, "herdr");
  // Records what reached which pane once Enter submits it; the delivery protocol itself is
  // covered by herdr-prompt.test.ts.
  writeFileSync(
    herdr,
    [
      "#!/bin/sh",
      'if [ "$HERDR_AGENT_CONTROL_FAIL" = "1" ]; then exit 7; fi',
      `printf '%s|%s|%s\\n' "$2" "$5" "$6" >> "$HERDR_AGENT_CONTROL_DELIVERED"`,
      "",
    ].join("\n"),
  );
  chmodSync(herdr, 0o755);
  process.env.PATH = `${BIN_PATH}:${ORIGINAL_PATH ?? ""}`;
  process.env.HERDR_AGENT_CONTROL_DELIVERED = DELIVERED_PATH;
});

afterAll(() => {
  process.env.PATH = ORIGINAL_PATH;
  delete process.env.HERDR_AGENT_CONTROL_DELIVERED;
  delete process.env.HERDR_AGENT_CONTROL_FAIL;
  rmSync(HOME, { recursive: true, force: true });
});

test("inputText delivers to the session and pane named by the execution target", async () => {
  const control = herdrAgentControl(HOME);

  await control.inputText(TARGET, "-continue");

  expect(
    readFileSync(DELIVERED_PATH, "utf8").split("\n").filter(Boolean),
  ).toEqual(["repo-session|w1:p2|-continue", "repo-session|w1:p2|Enter"]);
});

test("inputText propagates the Herdr failure to the caller", async () => {
  const control = herdrAgentControl(HOME);
  process.env.HERDR_AGENT_CONTROL_FAIL = "1";

  await expect(control.inputText(TARGET, "retry")).rejects.toThrowError(
    "Herdr exited with status 7",
  );
});
