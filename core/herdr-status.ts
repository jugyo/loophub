// Pure decisioning for the sidebar herdr-session status (#495): parse the JSON the
// herdr CLI prints and match running sessions back to registered repos. The CLI output
// crosses a process boundary, so every parser here is defensive — malformed or
// unexpected output yields an empty result instead of throwing, because "herdr said
// something we don't understand" must degrade to "no sessions", never to a 500.
import {
  herdrSessionName,
  type TerminalLaunchRepo,
} from "./terminal-launch.ts";
import { pullNumberFromWorktreePath } from "./worktree-path.ts";

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
  /** Raw herdr agent_status (known values: working | blocked | done | idle). */
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
 * A running herdr agent's pane, matched back to the PR whose worktree it's running in (#579 —
 * the issue-list "Herdr running" badge). `pane_id` is a valid `herdr agent focus` target
 * (#578), so focusing it resolves the agent's workspace/tab/pane in one call.
 */
export interface HerdrPullWorkspace {
  pull: number;
  pane_id: string;
}

/**
 * Maps running herdr agents back to the PR worktree each is running in (#579 — the issue-list
 * "Herdr running" badge). Reuses the same `agent list` JSON parseHerdrAgentList reads (its
 * `foreground_cwd`/`cwd` fields, not extracted there since they aren't part of the client-facing
 * HerdrAgent shape) — no extra herdr shellout. An agent's absolute cwd is only ever used here to
 * resolve a PR number and then discarded; it must never reach the client (see terminal.sessions
 * in service.ts, which returns this array as-is).
 *
 * Only agents with a real pane_id (not the NO_PANE_ID_PREFIX positional fallback — see
 * parseHerdrAgentList) whose cwd resolves to the current pr-<n> worktree convention produce an
 * entry — a repo-root cwd, the legacy issue-<n> convention, or a missing/malformed field is
 * silently skipped, matching this file's degrade-to-empty tolerance for unexpected or older
 * herdr output. When several agents share one PR's worktree, only the first is kept.
 */
export function herdrPullWorkspacesFromAgentList(
  stdout: string,
  worktreeRoot: string,
  fullName: string,
): HerdrPullWorkspace[] {
  const parsed = tryParse(stdout);
  const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
  if (!Array.isArray(agents)) return [];
  const byPull = new Map<number, HerdrPullWorkspace>();
  for (const a of agents) {
    if (typeof a !== "object" || a === null) continue;
    const rec = a as {
      pane_id?: unknown;
      foreground_cwd?: unknown;
      cwd?: unknown;
    };
    if (typeof rec.pane_id !== "string" || rec.pane_id === "") continue;
    const cwd =
      typeof rec.foreground_cwd === "string" && rec.foreground_cwd !== ""
        ? rec.foreground_cwd
        : typeof rec.cwd === "string" && rec.cwd !== ""
          ? rec.cwd
          : null;
    if (cwd === null) continue;
    const pull = pullNumberFromWorktreePath(worktreeRoot, fullName, cwd);
    if (pull === null || byPull.has(pull)) continue;
    byPull.set(pull, { pull, pane_id: rec.pane_id });
  }
  return [...byPull.values()];
}

/** One workspace inside a herdr session, from `herdr --session <name> workspace list`. */
export interface HerdrWorkspace {
  id: string;
  label: string;
  number: number;
}

export function parseHerdrWorkspaceList(stdout: string): HerdrWorkspace[] {
  const parsed = tryParse(stdout);
  const workspaces = (parsed as { result?: { workspaces?: unknown } })?.result
    ?.workspaces;
  if (!Array.isArray(workspaces)) return [];
  const out: HerdrWorkspace[] = [];
  for (const w of workspaces) {
    if (typeof w !== "object" || w === null) continue;
    const rec = w as {
      workspace_id?: unknown;
      label?: unknown;
      number?: unknown;
    };
    if (typeof rec.workspace_id !== "string" || rec.workspace_id === "")
      continue;
    out.push({
      id: rec.workspace_id,
      label: typeof rec.label === "string" ? rec.label : rec.workspace_id,
      number: typeof rec.number === "number" ? rec.number : 0,
    });
  }
  return out;
}

/** One tab inside a herdr session, from `herdr --session <name> tab list`. */
export interface HerdrTab {
  id: string;
  workspaceId: string;
  number: number;
}

export function parseHerdrTabList(stdout: string): HerdrTab[] {
  const parsed = tryParse(stdout);
  const tabs = (parsed as { result?: { tabs?: unknown } })?.result?.tabs;
  if (!Array.isArray(tabs)) return [];
  const out: HerdrTab[] = [];
  for (const t of tabs) {
    if (typeof t !== "object" || t === null) continue;
    const rec = t as {
      tab_id?: unknown;
      workspace_id?: unknown;
      number?: unknown;
    };
    if (
      typeof rec.tab_id !== "string" ||
      rec.tab_id === "" ||
      typeof rec.workspace_id !== "string" ||
      rec.workspace_id === ""
    )
      continue;
    out.push({
      id: rec.tab_id,
      workspaceId: rec.workspace_id,
      number: typeof rec.number === "number" ? rec.number : 0,
    });
  }
  return out;
}

/**
 * One agent placed in a session's workspace/tab, plus the PR its worktree cwd resolves to
 * (#602 — `lh herdr`'s hierarchical view). A standalone tolerant parse over the same `agent
 * list` JSON parseHerdrAgentList/herdrPullWorkspacesFromAgentList already read, rather than
 * joining their outputs by index — parseHerdrAgentList silently drops name-less entries, so
 * zipping its (filtered) result back against the raw array by position would misalign once any
 * entry is dropped.
 */
export interface HerdrAgentPlacement {
  id: string;
  name: string;
  status: string;
  workspaceId: string | null;
  tabId: string | null;
  pull: number | null;
}

export function parseHerdrAgentPlacements(
  stdout: string,
  worktreeRoot: string,
  fullName: string,
): HerdrAgentPlacement[] {
  const parsed = tryParse(stdout);
  const agents = (parsed as { result?: { agents?: unknown } })?.result?.agents;
  if (!Array.isArray(agents)) return [];
  const out: HerdrAgentPlacement[] = [];
  for (const a of agents) {
    if (typeof a !== "object" || a === null) continue;
    const rec = a as {
      name?: unknown;
      agent_status?: unknown;
      pane_id?: unknown;
      workspace_id?: unknown;
      tab_id?: unknown;
      foreground_cwd?: unknown;
      cwd?: unknown;
    };
    if (typeof rec.name !== "string" || rec.name === "") continue;
    const cwd =
      typeof rec.foreground_cwd === "string" && rec.foreground_cwd !== ""
        ? rec.foreground_cwd
        : typeof rec.cwd === "string" && rec.cwd !== ""
          ? rec.cwd
          : null;
    out.push({
      id:
        typeof rec.pane_id === "string" && rec.pane_id !== ""
          ? rec.pane_id
          : `${NO_PANE_ID_PREFIX}${out.length}`,
      name: rec.name,
      status: typeof rec.agent_status === "string" ? rec.agent_status : "",
      workspaceId:
        typeof rec.workspace_id === "string" ? rec.workspace_id : null,
      tabId: typeof rec.tab_id === "string" ? rec.tab_id : null,
      pull:
        cwd !== null
          ? pullNumberFromWorktreePath(worktreeRoot, fullName, cwd)
          : null,
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
 * Foreground process argvs from `herdr --session <name> pane process-info --pane <pane_id>`,
 * which prints `{ result: { process_info: { foreground_processes: [{ argv: [...] }, ...] } } }`.
 * Entries without a usable `argv` (e.g. a process herdr could only identify by name) are
 * dropped rather than failing the whole parse. Null on anything unparseable, matching the other
 * parsers here.
 */
export function parseHerdrPaneProcessInfo(stdout: string): string[][] | null {
  const parsed = tryParse(stdout);
  const processes = (
    parsed as {
      result?: { process_info?: { foreground_processes?: unknown } };
    }
  )?.result?.process_info?.foreground_processes;
  if (!Array.isArray(processes)) return null;
  const out: string[][] = [];
  for (const p of processes) {
    const argv = (p as { argv?: unknown })?.argv;
    if (Array.isArray(argv) && argv.every((a) => typeof a === "string"))
      out.push(argv as string[]);
  }
  return out;
}

/**
 * True when one of a pane's foreground processes is exactly `claude --resume <session>` — the
 * literal argv commandForHerdrLaunch's "resume" workflow execs (a `cd <dir> &&` prefix is a
 * shell builtin, consumed before exec, so it never reaches the OS argv). Used to find a terminal
 * that's already resuming a given session (#578's Resume dedup): the herdr agent's *display name*
 * can't serve this purpose — two Resume launches for different sessions can share one (e.g. two
 * PRs' dev sessions both render as "Resume - dev"), which would make a name match a false
 * positive across unrelated sessions. The running process is ground truth for which session a
 * pane actually holds.
 */
export function paneRunsClaudeResume(
  processes: string[][],
  session: string,
): boolean {
  // Exact 3-element match, not just "argv contains --resume somewhere": a looser check would
  // also match a manually-run `claude --resume <session> --continue` (or any other extra flags)
  // in an unrelated pane, which is exactly the kind of false positive this function exists to
  // avoid (#578 review).
  return processes.some(
    (argv) =>
      argv.length === 3 &&
      argv[0] === "claude" &&
      argv[1] === "--resume" &&
      argv[2] === session,
  );
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
// sidebar preview (#554) renders SGR sequences as actual color via ansi_up, so those
// are kept intact; everything else here doesn't mean anything outside a live terminal
// (cursor moves, OSC titles/hyperlinks) or breaks a plain <pre> (stray \r/\r\n runs
// that look like broken wrapping) and is stripped, once, so every caller gets terminal
// output that's safe to render as either colored HTML or plain text.
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
// SGR (color/style) sequences specifically — same parameter-byte class as ANSI_CSI
// above, restricted to the 'm' final byte. Extracted via split/match in stripAnsi
// below *before* the generic stripping runs, so these survive intact for ansi_up to
// render as color: the generic passes below (especially ANSI_CSI_TRUNCATED, which has
// no final-byte requirement at all) can't tell a still-open CSI from one whose final
// byte is a color code worth keeping, so they'd otherwise eat an SGR sequence's
// leading parameter bytes (e.g. the "\x1b[32" of "\x1b[32m").
const ANSI_SGR = /\x1b\[[0-9;:]*m/g;
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
  const colors = text.match(ANSI_SGR) ?? [];
  const segments = text
    .split(ANSI_SGR)
    .map((segment) =>
      segment
        .replace(ANSI_CSI, "")
        .replace(ANSI_CSI_TRUNCATED, "")
        .replace(ANSI_OSC, "")
        .replace(ANSI_OTHER, "")
        .replace(ANSI_ESCAPE, ""),
    );
  let result = segments[0];
  for (const [i, color] of colors.entries()) {
    result += color + segments[i + 1];
  }
  return result.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
