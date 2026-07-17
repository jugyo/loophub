// Human-action log for the lh-web backend. A human driving the Web UI fires JSON-RPC methods;
// this module emits one `log.info` line (stdout + logs/lh-web.log) per action so an operator
// watching the terminal can see who did what — which workflow was launched, which pane was
// killed, which PR was merged. Only methods a human triggers that mutate herdr or PR state are
// listed here; read-only queries and mechanical/sweep RPCs are intentionally absent so the log
// stays signal, not noise.
import { log } from "./logger.ts";

type Params = Record<string, unknown>;
type Formatter = (params: Params) => string;

// Join `key=value` fields, dropping any whose value is undefined/null/empty.
function fields(...pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

// Maps a human-action RPC method to a concise description of what the operator did. Each message
// carries at minimum the action verb and the target identifiers (repo, PR/issue number, pane).
const ACTIONS: Record<string, Formatter> = {
  "terminal/launch": (p) =>
    `launch ${fields(
      ["workflow", p.workflow],
      ["repo", p.repo],
      ["issue", p.issueNumber ? `#${p.issueNumber}` : undefined],
      ["pr", p.prNumber ? `#${p.prNumber}` : undefined],
    )}`,
  "terminal/killAgent": (p) =>
    `kill agent ${fields(["repo", p.repo], ["pane", p.paneId])}`,
  "terminal/sendAgentInput": (p) =>
    `inject input ${fields(
      ["repo", p.repo],
      ["pr", p.pull ? `#${p.pull}` : undefined],
      ["pane", p.paneId],
    )}`,
  "pulls/merge": (p) =>
    `merge pr ${fields(
      ["repo", p.repo],
      ["pr", p.number ? `#${p.number}` : undefined],
      ["method", p.merge_method ?? "squash"],
    )}`,
};

// Emit a one-line stdout log for a human-triggered RPC action. Non-whitelisted methods (queries,
// sweeps, polling) are silently ignored. Called after the handler succeeds so only actions that
// actually completed are recorded.
export function logHumanAction(method: string, params: Params): void {
  const format = ACTIONS[method];
  if (!format) return;
  log.info(`human action: ${format(params)}`);
}
