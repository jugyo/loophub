import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "#loophub-test";

const HOME = mkdtempSync(join(tmpdir(), "lh-relay-"));
process.env.LOOPHUB_HOME = HOME;
process.env.LOOPHUB_DB = join(HOME, "test.db");

// A stand-in for `hc`: answers terminal.get from labels by address, and `attach` prints its window
// size, echoes its input, reports a resize, and prints its pid.
const BIN = join(HOME, "bin");
const PREVIOUS_PATH = process.env.PATH;
mkdirSync(BIN);
writeFileSync(
  join(BIN, "hc"),
  `#!/bin/bash
if [ "$1" = connect ]; then
  read -r request
  case "$request" in
    *'"t1"'*) labels='{"loophub.repo":"me/relay","loophub.pr":"7"}' ;;
    *'"t2"'*) labels='{"loophub.repo":"me/relay","loophub.pr":"8"}' ;;
    *'"t3"'*) labels='{"loophub.repo":"me/other","loophub.pr":"7"}' ;;
    *) labels='{}' ;;
  esac
  echo "{\\"jsonrpc\\":\\"2.0\\",\\"id\\":1,\\"result\\":{\\"labels\\":$labels}}"
  exit 0
fi
trap 'echo "size $(stty size) term $TERM"' WINCH
echo "pid $$"
echo "attached $2 size $(stty size) term $TERM"
stty -echo
while true; do
  if IFS= read -r -t 1 line; then
    [ "$line" = quit ] && exit 0
    echo "got $line"
  fi
done
`,
);
chmodSync(join(BIN, "hc"), 0o755);
process.env.PATH = `${BIN}:${PREVIOUS_PATH}`;

let server: ReturnType<typeof import("./http.ts").createLhWebServer>;
let base: string;

beforeAll(async () => {
  const S = await import("../../core/store.ts");
  const { createLhWebServer } = await import("./http.ts");
  const repo = S.createRepo("me/relay", join(HOME, "repo"));
  S.setRepoTerminalBackend(repo.id, "herdr-core");
  S.createRepo("me/herdr", join(HOME, "herdr"));
  server = createLhWebServer(undefined, { port: 0 });
  base = `127.0.0.1:${server.port}`;
});

afterAll(async () => {
  void server.stop(true);
  process.env.PATH = PREVIOUS_PATH;
  rmSync(HOME, { recursive: true, force: true });
});

function relayPath(params: Record<string, string> = {}): string {
  const query = new URLSearchParams({
    repo: "me/relay",
    pull: "7",
    terminal: "t1",
    cols: "100",
    rows: "30",
    ...params,
  });
  return `/ws/terminal?${query}`;
}

// A socket plus everything it has received so far.
function connect() {
  const ws = new WebSocket(`ws://${base}${relayPath()}`);
  ws.binaryType = "arraybuffer";
  const state = { output: "", closed: false };
  ws.onmessage = (event) => {
    state.output += new TextDecoder().decode(event.data);
  };
  ws.onclose = () => {
    state.closed = true;
  };
  return { ws, state };
}

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(20);
  expect(check(), what).toBe(true);
}

test("relays output, input and resize, and closing ends only the attach", async () => {
  const { ws, state } = connect();
  await until(
    () => state.output.includes("attached t1 size 30 100 term xterm-256color"),
    `attach banner in ${JSON.stringify(state.output)}`,
  );

  ws.send(new TextEncoder().encode("hello\n"));
  await until(() => state.output.includes("got hello"), "echoed input");

  ws.send(JSON.stringify({ cols: 120, rows: 40 }));
  await until(() => state.output.includes("size 40 120"), "resized");

  // A text frame that is no resize changes nothing.
  ws.send("not json");
  ws.close();
  const pid = Number(/pid (\d+)/.exec(state.output)?.[1]);
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, "hc attach has exited");
});

test("the socket closes when the attach exits", async () => {
  const { ws, state } = connect();
  await until(() => state.output.includes("attached t1"), "attached");
  ws.send(new TextEncoder().encode("quit\n"));
  await until(() => state.closed, "socket closed");
});

async function upgradeStatus(
  headers: Record<string, string> = {},
  params: Record<string, string> = {},
): Promise<number> {
  const res = await fetch(`http://${base}${relayPath(params)}`, {
    headers: {
      connection: "upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      ...headers,
    },
  });
  await res.body?.cancel();
  return res.status;
}

test("refuses an upgrade from anywhere but loopback", async () => {
  const { setInstanceSetting } = await import(
    "../../core/store/instance-settings.ts"
  );
  setInstanceSetting("public_origin", "https://lh.example.com");
  // public_origin passes the RPC Origin rule, and still gets no terminal.
  expect(await upgradeStatus({ origin: "https://lh.example.com" })).toBe(403);
  expect(await upgradeStatus({ origin: "https://evil.example.com" })).toBe(403);
  expect(await upgradeStatus({ "x-forwarded-for": "203.0.113.1" })).toBe(403);
  expect(await upgradeStatus({ "sec-fetch-site": "cross-site" })).toBe(403);
});

test("refuses a terminal this repo and PR did not start", async () => {
  expect(await upgradeStatus({}, { terminal: "t2" })).toBe(409);
  expect(await upgradeStatus({}, { terminal: "t3" })).toBe(409);
  expect(await upgradeStatus({}, { terminal: "t9" })).toBe(409);
  expect(await upgradeStatus({}, { terminal: "--help" })).toBe(422);
  expect(await upgradeStatus({}, { repo: "me/herdr" })).toBe(409);
  expect(await upgradeStatus({}, { repo: "me/none" })).toBe(404);
});

test("a plain GET gets no socket", async () => {
  const res = await fetch(`http://${base}${relayPath()}`);
  await res.body?.cancel();
  expect(res.status).toBe(426);
});
