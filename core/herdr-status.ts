// Pure decisioning for the sidebar herdr-session status (#495): parse the JSON the
// herdr CLI prints and match running sessions back to registered repos. The CLI output
// crosses a process boundary, so every parser here is defensive — malformed or
// unexpected output yields an empty result instead of throwing, because "herdr said
// something we don't understand" must degrade to "no sessions", never to a 500.
import {
  herdrSessionName,
  type TerminalLaunchRepo,
} from "./terminal-launch.ts";

/** One agent inside a herdr session, as shown in the sidebar. */
export interface HerdrAgent {
  /**
   * Stable identity within the session (herdr pane_id when present). Agent names are
   * not guaranteed unique — two label-less launches share one — so display code must
   * not key on `name`.
   */
  id: string;
  /** Display name, e.g. "dev #486". */
  name: string;
  /** Raw herdr agent_status (known values: working | blocked | idle). */
  status: string;
}

// Prefix for the positional-fallback id assigned below when herdr omits pane_id. Built via
// fromCharCode(0) so the leading control byte never appears as a literal in the source. That
// control byte keeps the prefix out of the pane_id namespace, so a real pane_id can never
// collide with it — service.ts checks this prefix to refuse a pane-close call against an
// agent that has no real pane to close.
export const NO_PANE_ID_PREFIX = `${String.fromCharCode(0)}idx:`;

/** Running session names from `herdr session list --json` output. */
export function parseHerdrSessionList(stdout: string): string[] {
  const parsed = tryParse(stdout);
  const sessions = (parsed as { sessions?: unknown })?.sessions;
  if (!Array.isArray(sessions)) return [];
  const names: string[] = [];
  for (const s of sessions) {
    if (
      typeof s === "object" &&
      s !== null &&
      typeof (s as { name?: unknown }).name === "string" &&
      (s as { running?: unknown }).running === true
    ) {
      names.push((s as { name: string }).name);
    }
  }
  return names;
}

/**
 * Agents from `herdr --session <name> agent list` output. The command prints JSON
 * without any flag (`--json` is not accepted): `{ result: { agents: [...] } }`.
 */
export function parseHerdrAgentList(stdout: string): HerdrAgent[] {
  const parsed = tryParse(stdout);
  const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
  if (!Array.isArray(agents)) return [];
  const out: HerdrAgent[] = [];
  for (const a of agents) {
    if (typeof a !== "object" || a === null) continue;
    const rec = a as {
      name?: unknown;
      agent_status?: unknown;
      pane_id?: unknown;
    };
    if (typeof rec.name !== "string" || rec.name === "") continue;
    out.push({
      // The positional fallback stays unique within one parse; NO_PANE_ID_PREFIX's control
      // byte keeps it out of the pane_id namespace, so a real pane_id can never collide with it.
      id:
        typeof rec.pane_id === "string" && rec.pane_id !== ""
          ? rec.pane_id
          : `${NO_PANE_ID_PREFIX}${out.length}`,
      name: rec.name,
      status: typeof rec.agent_status === "string" ? rec.agent_status : "",
    });
  }
  return out;
}

/**
 * Match repos to their running herdr session. Session names are deterministic
 * (`herdrSessionName`), so the repo -> session direction needs no herdr state
 * beyond the running-name list.
 */
export function reposWithRunningSession<T extends TerminalLaunchRepo>(
  repos: T[],
  runningNames: string[],
): { repo: T; sessionName: string }[] {
  const running = new Set(runningNames);
  const out: { repo: T; sessionName: string }[] = [];
  for (const repo of repos) {
    const sessionName = herdrSessionName(repo);
    if (running.has(sessionName)) out.push({ repo, sessionName });
  }
  return out;
}

/**
 * Preview text from `herdr --session <name> agent read <target> --source recent
 * --lines N`, which prints `{ result: { read: { text: "..." } } }` (also without
 * `--json`, like `agent list`). Null on anything unparseable, so the caller's
 * "no preview" fallback needs no separate empty-string check.
 */
export function parseHerdrAgentRead(stdout: string): string | null {
  const parsed = tryParse(stdout);
  const text = (parsed as { result?: { read?: { text?: unknown } } })?.result
    ?.read?.text;
  return typeof text === "string" ? stripAnsi(text) : null;
}

/**
 * Target pane's size from `herdr --session <name> pane layout --pane <pane_id>`, which
 * prints `{ result: { layout: { area: { width, height, ... } } } }`. `width`/`height` are
 * character-cell counts (columns/rows), used to size the sidebar hover preview to the
 * pane's actual shape instead of a fixed box (#531). Null on anything unparseable or
 * non-positive — the caller then falls back to a fixed size, same tolerance as the other
 * parsers here.
 */
export function parseHerdrPaneLayout(
  stdout: string,
): { cols: number; rows: number } | null {
  const parsed = tryParse(stdout);
  const area = (parsed as { result?: { layout?: { area?: unknown } } })?.result
    ?.layout?.area;
  if (typeof area !== "object" || area === null) return null;
  const { width, height } = area as { width?: unknown; height?: unknown };
  if (
    typeof width !== "number" ||
    typeof height !== "number" ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return null;
  }
  return { cols: Math.round(width), rows: Math.round(height) };
}

// herdr's recent-pane buffer is raw terminal output: SGR color codes, cursor moves,
// and lone carriage returns (progress-bar overwrites) are all still in there. The
// sidebar preview (#523) renders this text as-is inside a plain <pre>, which doesn't
// interpret escape sequences the way a terminal does — left untouched, they show up
// as literal garbage (e.g. "[32m") and stray \r/\r\n runs that look like broken
// wrapping. Strip them down to plain text here, once, so every caller gets clean output.
// Parameter bytes include ':' too (ITU-T colon syntax for direct-color SGR, e.g.
// "\x1b[38:2:255:0:0m"), not just the more common ';'-delimited form. Deliberately no
// intermediate-byte class (ECMA-48 allows one, values 0x20-0x2F i.e. space through '/')
// between the parameters and the final byte: real terminal programs essentially never
// emit one, but the final-byte class below (`[@-~]`) is broad enough to match almost
// any letter — so an intermediate class here would let a literal space in ordinary
// prose immediately after a CSI-like "\x1b[<digits>" get treated as filler and the
// first following letter as the "final byte", deleting real text up to that letter
// (e.g. "\x1b[123 processes running" losing "123 p"). Dropping the class means such
// input simply doesn't match here at all, falling through to ANSI_CSI_TRUNCATED below.
const ANSI_CSI = /\x1b\[[0-9;:?]*[@-~]/g;
// The middle class excludes \x1b (not just \x07): without that, an ST-terminated OSC
// sequence (e.g. an OSC 8 hyperlink) greedily backtracks past a *later* unrelated OSC's
// terminator, deleting real text in between — and on adversarial input (many bare
// "\x1b]" with no terminator) the same greedy backtracking is O(n^2), a DoS on lh-web's
// single-threaded event loop given herdr output can run up to HERDR_CAPTURE_MAX_BYTES.
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// A CSI introducer that never reaches a valid final byte — e.g. the recent-pane window
// starts mid-sequence, cutting off "\x1b[1" before its "m" — doesn't match ANSI_CSI
// above (no final byte = no match at that position), so its parameter bytes would
// otherwise survive as literal garbage once the lone ESC is stripped below. Runs after
// ANSI_CSI has already removed every well-formed sequence, so only true leftovers match.
// Same no-intermediate-class reasoning as ANSI_CSI above — this only ever consumes
// parameter bytes, never text that follows them.
const ANSI_CSI_TRUNCATED = /\x1b\[[0-9;:?]*/g;
// DECSC/DECRC (save/restore cursor), IND/NEL/RI (line motion), RIS (reset) — single-byte
// ESC sequences besides charset designation and keypad mode.
const ANSI_OTHER = /\x1b[()][A-Za-z0-9]|\x1b[=>]|\x1b[78DMEc]/g;
const ANSI_ESCAPE = /\x1b/g;

function stripAnsi(text: string): string {
  return text
    .replace(ANSI_CSI, "")
    .replace(ANSI_CSI_TRUNCATED, "")
    .replace(ANSI_OSC, "")
    .replace(ANSI_OTHER, "")
    .replace(ANSI_ESCAPE, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
