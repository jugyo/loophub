import type { CodingAgent } from "./shared.ts";
import {
  actorFor,
  agentEffort,
  agentModel,
  autoModeOnBuild,
  codingAgent,
  devCostLimitUsd,
  S,
  ServiceError,
  updateAgentAutoModeOnBuild,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  updateDevCostLimitUsd,
} from "./shared.ts";

function hasAtMostTwoDecimalPlaces(value: number): boolean {
  return Math.abs(value * 100 - Math.round(value * 100)) < 1e-9;
}

function validateAgentScopedSetting(
  agent: CodingAgent | undefined,
): asserts agent is CodingAgent {
  if (agent !== "claude-code" && agent !== "codex") {
    throw new ServiceError(422, "agent must be one of: claude-code, codex");
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
    agents: Record<
      CodingAgent,
      { autoModeOnBuild: boolean; model: string; effort: string }
    >;
    codingAgent: CodingAgent;
    devCostLimitUsd: number;
  } {
    return {
      agents: {
        "claude-code": {
          autoModeOnBuild: autoModeOnBuild("claude-code"),
          model: agentModel("claude-code"),
          effort: agentEffort("claude-code"),
        },
        codex: {
          autoModeOnBuild: autoModeOnBuild("codex"),
          model: agentModel("codex"),
          effort: agentEffort("codex"),
        },
      },
      codingAgent: codingAgent(),
      devCostLimitUsd: devCostLimitUsd(),
    };
  },

  update(
    input: {
      // Which agent autoModeOnBuild/model/effort is being set for (#593, #594, #682); required
      // together with any of them, ignored otherwise.
      agent?: CodingAgent;
      autoModeOnBuild?: boolean;
      // Default model this agent launches with when `lh build --model` is omitted (#594).
      model?: string;
      // Default effort paired with model in the Settings screen (#682).
      effort?: string;
      codingAgent?: CodingAgent;
      devCostLimitUsd?: number;
    },
    sessionId?: string | null,
  ): {
    agents: Record<
      CodingAgent,
      { autoModeOnBuild: boolean; model: string; effort: string }
    >;
    codingAgent: CodingAgent;
    devCostLimitUsd: number;
  } {
    if (input.autoModeOnBuild !== undefined) {
      if (typeof input.autoModeOnBuild !== "boolean") {
        throw new ServiceError(422, "autoModeOnBuild must be a boolean");
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
    if (
      input.codingAgent !== undefined &&
      input.codingAgent !== "claude-code" &&
      input.codingAgent !== "codex"
    ) {
      throw new ServiceError(
        422,
        "codingAgent must be one of: claude-code, codex",
      );
    }
    if (input.devCostLimitUsd !== undefined) {
      validateDevCostLimitUsd(input.devCostLimitUsd);
    }

    if (input.autoModeOnBuild !== undefined) {
      const agent = input.agent;
      validateAgentScopedSetting(agent);
      updateAgentAutoModeOnBuild(agent, input.autoModeOnBuild);
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
