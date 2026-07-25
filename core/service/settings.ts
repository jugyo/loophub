import {
  agentEffort,
  agentModel,
  autoModeOnLaunch,
  type CodingAgent,
  codingAgent,
  devCostLimitUsd,
  updateAgentAutoModeOnLaunch,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  updateDevCostLimitUsd,
} from "../config.ts";
import { ServiceError } from "../errors.ts";
import { CODING_AGENTS, isCodingAgent } from "../runtimes.ts";
import * as S from "../store.ts";
import {
  WORKFLOW_CONTRACT_LANGUAGES,
  type WorkflowContractLanguage,
} from "../workflow/contracts.ts";
import { actorFor } from "./shared.ts";

// The accepted coding-agent ids, for validation error messages ("claude-code, codex, grok").
const CODING_AGENTS_SENTENCE = CODING_AGENTS.join(", ");
const WORKFLOW_CONTRACT_LANGUAGE_KEY = "workflow_contract_language";

export function workflowContractLanguage(): WorkflowContractLanguage {
  const value = S.getInstanceSetting(WORKFLOW_CONTRACT_LANGUAGE_KEY);
  return value === "ja" ? "ja" : "en";
}

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
// Instance-level settings, as opposed to repo-scoped settings. Existing agent/cost values live in
// config.json; Workflow contract language lives in SQLite so every process shares one source.
export const settings = {
  get(): {
    agents: Record<CodingAgent, AgentSettingsShape>;
    codingAgent: CodingAgent;
    devCostLimitUsd: number;
    workflowContractLanguage: WorkflowContractLanguage;
  } {
    return {
      agents: agentSettings(),
      codingAgent: codingAgent(),
      devCostLimitUsd: devCostLimitUsd(),
      workflowContractLanguage: workflowContractLanguage(),
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
      workflowContractLanguage?: WorkflowContractLanguage;
    },
    sessionId?: string | null,
  ): {
    agents: Record<CodingAgent, AgentSettingsShape>;
    codingAgent: CodingAgent;
    devCostLimitUsd: number;
    workflowContractLanguage: WorkflowContractLanguage;
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
    if (
      input.workflowContractLanguage !== undefined &&
      !WORKFLOW_CONTRACT_LANGUAGES.includes(input.workflowContractLanguage)
    ) {
      throw new ServiceError(
        422,
        "workflowContractLanguage must be one of: en, ja",
      );
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
    if (input.workflowContractLanguage !== undefined) {
      S.setInstanceSetting(
        WORKFLOW_CONTRACT_LANGUAGE_KEY,
        input.workflowContractLanguage,
      );
    }
    const actor = actorFor(sessionId);
    S.emitEvent(null, "settings.updated", actor, input);
    return settings.get();
  },
};
