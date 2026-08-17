import type * as S from "../store.ts";
import { claudeUsageSync } from "./claude.ts";
import { codexUsageSync } from "./codex.ts";
import { grokUsageSync } from "./grok.ts";
import { opencodeUsageSync } from "./opencode.ts";
import type {
  SessionUsageSyncCohort,
  SessionUsageSyncModule,
  SessionUsageSyncOptions,
} from "./plan.ts";

export { applySessionUsageSync } from "./executor.ts";
export type {
  SessionUsagePlan,
  SessionUsageSyncCohort,
  SessionUsageSyncModule,
  SessionUsageSyncOptions,
  SessionUsageSyncRow,
  SessionUsageSyncStatus,
} from "./plan.ts";

// Consulted in order; Claude Code claims whatever the explicit runtimes leave.
const MODULES: SessionUsageSyncModule[] = [
  codexUsageSync,
  grokUsageSync,
  opencodeUsageSync,
  claudeUsageSync,
];

/**
 * Turn the swept sessions into the cohorts of plans that describe their sync. Reads the filesystem
 * and the store; writes nothing — `applySessionUsageSync` owns every DB change.
 */
export function planSessionUsageSync(
  rows: S.AgentSessionRow[],
  options: SessionUsageSyncOptions,
): SessionUsageSyncCohort[] {
  const rowsByModule = new Map<SessionUsageSyncModule, S.AgentSessionRow[]>();
  for (const row of rows) {
    const module = MODULES.find((candidate) => candidate.owns(row));
    if (!module) continue;
    const claimed = rowsByModule.get(module) ?? [];
    claimed.push(row);
    rowsByModule.set(module, claimed);
  }
  return MODULES.flatMap((module) => {
    const claimed = rowsByModule.get(module);
    return claimed ? module.plan(claimed, options) : [];
  });
}
