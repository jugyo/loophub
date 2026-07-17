import type { CodingAgent } from "./shared.ts";
import {
  actorFor,
  agentEffort,
  agentModel,
  autoModeOnLaunch,
  CODING_AGENTS,
  codingAgent,
  devCostLimitUsd,
  isCodingAgent,
  S,
  ServiceError,
  updateAgentAutoModeOnLaunch,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  updateDevCostLimitUsd,
} from "./shared.ts";

// The accepted coding-agent ids, for validation error messages ("claude-code, codex, grok").
const CODING_AGENTS_SENTENCE = CODING_AGENTS.join(", ");

interface AgentSettingsShape {
  autoModeOnLaunch: boolean;
  model: string;
  effort: string;
}

// The per-agent settings block for every runtime, derived from the registry order so a new runtime
// surfaces here without another hand-written entry.
function agentSettings(): Record<CodingAgent, AgentSettingsShape> {
  return Object.fromEntries(
    CODING_AGENTS.map((agent) => [
      agent,
      {
        autoModeOnLaunch: autoModeOnLaunch(agent),
        model: agentModel(agent),
        effort: agentEffort(agent),
      },
    ]),
  ) as Record<CodingAgent, AgentSettingsShape>;
}

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

function validateAgentScopedSetting(
  agent: CodingAgent | undefined,
): asserts agent is CodingAgent {
  if (!isCodingAgent(agent)) {
    throw new ServiceError(
      422,
      `agent must be one of: ${CODING_AGENTS_SENTENCE}`,
    );
  }
}

function validateDevCostLimitUsd(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ServiceError(422, "devCostLimitUsd must be greater than 0");
  }
  if (value > 1000) {
    throw new ServiceError(422, "devCostLimitUsd must be at most 1000");
  }
  if (!hasAtMostTwoDecimalPlaces(value)) {
    throw new ServiceError(
      422,
      "devCostLimitUsd must use at most two decimal places",
    );
  }
}

// ===== global settings =====
// Instance-level config.json settings, as opposed to the repo-scoped settings above (#474).
export const settings = {
  get(): {
    agents: Record<CodingAgent, AgentSettingsShape>;
    codingAgent: CodingAgent;
    devCostLimitUsd: number;
  } {
    return {
      agents: agentSettings(),
      codingAgent: codingAgent(),
      devCostLimitUsd: devCostLimitUsd(),
    };
  },

  update(
    input: {
      // Which agent autoModeOnLaunch/model/effort is being set for (#593, #594, #682); required
      // together with any of them, ignored otherwise.
      agent?: CodingAgent;
      autoModeOnLaunch?: boolean;
      // Default model this agent launches with when no explicit --model is passed (#594).
      model?: string;
      // Default effort paired with model in the Settings screen (#682).
      effort?: string;
      codingAgent?: CodingAgent;
      devCostLimitUsd?: number;
    },
    sessionId?: string | null,
  ): {
    agents: Record<CodingAgent, AgentSettingsShape>;
    codingAgent: CodingAgent;
    devCostLimitUsd: number;
  } {
    if (input.autoModeOnLaunch !== undefined) {
      if (typeof input.autoModeOnLaunch !== "boolean") {
        throw new ServiceError(422, "autoModeOnLaunch must be a boolean");
      }
      validateAgentScopedSetting(input.agent);
    }
    if (input.model !== undefined) {
      if (typeof input.model !== "string" || !input.model.trim()) {
        throw new ServiceError(422, "model must be a non-empty string");
      }
      validateAgentScopedSetting(input.agent);
    }
    if (input.effort !== undefined) {
      if (typeof input.effort !== "string" || !input.effort.trim()) {
        throw new ServiceError(422, "effort must be a non-empty string");
      }
      validateAgentScopedSetting(input.agent);
    }
    if (input.codingAgent !== undefined && !isCodingAgent(input.codingAgent)) {
      throw new ServiceError(
        422,
        `codingAgent must be one of: ${CODING_AGENTS_SENTENCE}`,
      );
    }
    if (input.devCostLimitUsd !== undefined) {
      validateDevCostLimitUsd(input.devCostLimitUsd);
    }

    if (input.autoModeOnLaunch !== undefined) {
      const agent = input.agent;
      validateAgentScopedSetting(agent);
      updateAgentAutoModeOnLaunch(agent, input.autoModeOnLaunch);
    }
    if (input.model !== undefined) {
      const agent = input.agent;
      validateAgentScopedSetting(agent);
      updateAgentDefaultModel(agent, input.model.trim());
    }
    if (input.effort !== undefined) {
      const agent = input.agent;
      validateAgentScopedSetting(agent);
      updateAgentDefaultEffort(agent, input.effort.trim());
    }
    if (input.codingAgent !== undefined) {
      updateConfig({ codingAgent: input.codingAgent });
    }
    if (input.devCostLimitUsd !== undefined) {
      updateDevCostLimitUsd(input.devCostLimitUsd);
    }
    const actor = actorFor(sessionId);
    S.emitEvent(null, "settings.updated", actor, input);
    return settings.get();
  },
};
