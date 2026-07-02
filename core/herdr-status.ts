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
      // The positional fallback stays unique within one parse; the NUL byte keeps it
      // out of the pane_id namespace, so a real pane_id can never collide with it.
      id:
        typeof rec.pane_id === "string" && rec.pane_id !== ""
          ? rec.pane_id
          : `\u0000idx:${out.length}`,
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
  return typeof text === "string" ? text : null;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
