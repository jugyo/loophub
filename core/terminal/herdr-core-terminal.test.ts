import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "#loophub-test";
import { configDir } from "../config.ts";
import { callHerdrCore, runHerdrCore } from "../herdr-core.ts";
import {
  herdrCoreLabels,
  isHerdrCoreAddress,
  launchHerdrCoreTerminal,
} from "./herdr-core-terminal.ts";

const HAS_HC = Bun.which("hc") !== null;
const DIR = mkdtempSync("/tmp/lhtm-");
const PREVIOUS_ENV = { ...process.env };
Object.assign(process.env, {
  HC_SESSION: "lhtm",
  XDG_STATE_HOME: join(DIR, "s"),
  XDG_CONFIG_HOME: join(DIR, "c"),
  XDG_RUNTIME_DIR: join(DIR, "r"),
});
delete process.env.HC_SOCKET;
delete process.env.HC_TERMINAL_ID;

afterAll(async () => {
  if (HAS_HC) await runHerdrCore(["server", "stop"]);
  process.env = PREVIOUS_ENV;
  rmSync(DIR, { recursive: true, force: true });
});

function screen(address: string): Promise<string> {
  return (
    callHerdrCore("terminal.read", { terminal: address }) as Promise<{
      text: string;
    }>
  ).then((read) => read.text);
}

async function untilScreenHas(address: string, text: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!(await screen(address)).includes(text)) {
    if (Date.now() > deadline)
      throw new Error(`${text} not on screen: ${await screen(address)}`);
    await Bun.sleep(50);
  }
}

test("an address and a herdr pane id are told apart by shape", () => {
  for (const address of ["t7", "t1b"])
    expect(isHerdrCoreAddress(address)).toBe(true);
  for (const paneId of ["w1:p2", "wP:p2", "%7", "t", "--t7", "T7"])
    expect(isHerdrCoreAddress(paneId)).toBe(false);
});

test("labels carry only what the launch has", () => {
  expect(herdrCoreLabels({ repo: "a/b", role: "issue-create" })).toEqual({
    "loophub.repo": "a/b",
    "loophub.role": "issue-create",
  });
});

describe.skipIf(!HAS_HC)("against an isolated core", () => {
  // Started here, before any launch, so whatever env a terminal sees came from its own launch.
  beforeAll(async () => {
    await runHerdrCore(["server", "start"]);
  });

  test("a launch hands the program its argv, cwd and env directly", async () => {
    const prompt = `line one\nit's "quoted" $HOME\n--flag-like`;
    const address = await launchHerdrCoreTerminal({
      argv: [
        "sh",
        "-c",
        'printf "%s|%s|%s\\n" "$1" "$PWD" "$FROM_LAUNCH"; sleep 30',
        "sh",
        prompt,
      ],
      cwd: "/tmp",
      env: { FROM_LAUNCH: "yes" },
      labels: { "loophub.repo": "a/b" },
    });
    await untilScreenHas(address, "|yes");
    const text = await screen(address);
    expect(text).toContain(`it's "quoted" $HOME`);
    expect(text).toContain("/tmp");
    await callHerdrCore("terminal.kill", { terminal: address });
  });

  test("a launcher's LoopHub home reaches the terminal, set or not", async () => {
    process.env.LOOPHUB_HOME = "/launcher/home";
    const address = await launchHerdrCoreTerminal({
      argv: ["sh", "-c", 'echo "home=$LOOPHUB_HOME."; sleep 30'],
      cwd: "/tmp",
      labels: {},
    });
    await untilScreenHas(address, "home=");
    expect(await screen(address)).toContain("home=/launcher/home.");
    // The default home is passed explicitly too, so it overrides whatever the core was started with.
    delete process.env.LOOPHUB_HOME;
    const defaulted = await launchHerdrCoreTerminal({
      argv: ["sh", "-c", 'echo "home=$LOOPHUB_HOME."; sleep 30'],
      cwd: "/tmp",
      labels: {},
    });
    await untilScreenHas(defaulted, "home=");
    expect(await screen(defaulted)).toContain(`home=${configDir()}.`);
    await callHerdrCore("terminal.kill", { terminal: defaulted });
    await callHerdrCore("terminal.kill", { terminal: address });
  });

  test("a runtime that only pre-fills its prompt gets Enter once its UI is up", async () => {
    const address = await launchHerdrCoreTerminal({
      argv: [
        "sh",
        "-c",
        "sleep 1; echo shift+tab; read line; echo submitted; sleep 30",
      ],
      cwd: "/tmp",
      labels: {},
      submitPrompt: true,
    });
    await untilScreenHas(address, "submitted");
    await callHerdrCore("terminal.kill", { terminal: address });
  });

  test("a launch whose Enter fails ends its terminal instead of leaving it running", async () => {
    // Enter fails only when the terminal is gone between run and keys; a fake hc scripts that call.
    const bin = join(DIR, "bin");
    mkdirSync(bin);
    const realHc = Bun.which("hc");
    writeFileSync(
      join(bin, "hc"),
      `#!/bin/sh
input=$(cat)
case "$input" in
  *terminal.wait*) printf '{"id":1,"result":{}}' ;;
  *terminal.keys*) printf '{"id":1,"error":{"code":-32000,"message":"no","data":{"kind":"unavailable"}}}' ;;
  *) printf '%s\\n' "$input" | '${realHc}' "$@" ;;
esac
`,
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      await expect(
        launchHerdrCoreTerminal({
          argv: ["sleep", "30"],
          cwd: "/tmp",
          labels: { "lhtest.keys": "1" },
          submitPrompt: true,
        }),
      ).rejects.toMatchObject({ status: 503 });
    } finally {
      process.env.PATH = path;
    }
    const left = (await callHerdrCore("terminal.list", {
      labels: { "lhtest.keys": "1" },
    })) as { terminals: unknown[] };
    expect(left.terminals).toEqual([]);
  });

  test("a finished terminal refuses a send visibly", async () => {
    const address = await launchHerdrCoreTerminal({
      argv: ["true"],
      cwd: "/tmp",
      labels: {},
    });
    await Bun.sleep(300);
    await expect(
      callHerdrCore("terminal.send", { terminal: address, text: "x" }),
    ).rejects.toMatchObject({ status: 409, data: { kind: "finished" } });
  });
});
