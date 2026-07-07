import type { CodingAgent } from "./shared.ts";
import {
  actorFor,
  agentEffort,
  agentModel,
  autoModeOnBuild,
  codingAgent,
  S,
  ServiceError,
  updateAgentAutoModeOnBuild,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
} from "./shared.ts";

// ===== global settings =====
// Instance-level config.json settings, as opposed to the repo-scoped settings above (#474).
export const settings = {
  get(): {
    agents: Record<
      CodingAgent,
      { autoModeOnBuild: boolean; model: string; effort: string }
    >;
    codingAgent: CodingAgent;
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
    },
    sessionId?: string | null,
  ): {
    agents: Record<
      CodingAgent,
      { autoModeOnBuild: boolean; model: string; effort: string }
    >;
    codingAgent: CodingAgent;
  } {
    if (input.autoModeOnBuild !== undefined) {
      if (typeof input.autoModeOnBuild !== "boolean") {
        throw new ServiceError(422, "autoModeOnBuild must be a boolean");
      }
      if (input.agent !== "claude-code" && input.agent !== "codex") {
        throw new ServiceError(422, "agent must be one of: claude-code, codex");
      }
      updateAgentAutoModeOnBuild(input.agent, input.autoModeOnBuild);
    }
    if (input.model !== undefined) {
      if (typeof input.model !== "string" || !input.model.trim()) {
        throw new ServiceError(422, "model must be a non-empty string");
      }
      if (input.agent !== "claude-code" && input.agent !== "codex") {
        throw new ServiceError(422, "agent must be one of: claude-code, codex");
      }
      updateAgentDefaultModel(input.agent, input.model.trim());
    }
    if (input.effort !== undefined) {
      if (typeof input.effort !== "string" || !input.effort.trim()) {
        throw new ServiceError(422, "effort must be a non-empty string");
      }
      if (input.agent !== "claude-code" && input.agent !== "codex") {
        throw new ServiceError(422, "agent must be one of: claude-code, codex");
      }
      updateAgentDefaultEffort(input.agent, input.effort.trim());
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
    if (input.codingAgent !== undefined) {
      updateConfig({ codingAgent: input.codingAgent });
    }
    const actor = actorFor(sessionId);
    S.emitEvent(null, "settings.updated", actor, input);
    return settings.get();
  },
};
