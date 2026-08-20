import {
  agentEffort,
  agentEffortOverride,
  agentModel,
  agentModelOverride,
  type CodingAgent,
  codingAgent,
  devCostLimitUsd,
  notificationSound,
  updateAgentDefaultEffort,
  updateAgentDefaultModel,
  updateConfig,
  updateDevCostLimitUsd,
  updateNotificationSound,
} from "../config.ts";
import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { CODING_AGENTS, isCodingAgent } from "../runtimes.ts";
import type { AgentSettingsWire, GlobalSettingsWire } from "../serialize.ts";
import * as S from "../store.ts";
import { isTheme, type Theme } from "../theme.ts";
import {
  WORKFLOW_CONTRACT_LANGUAGES,
  type WorkflowContractLanguage,
} from "../workflow/contracts.ts";
import { actorFor } from "./shared.ts";

// The accepted coding-agent ids, for validation error messages ("claude-code, codex, grok").
const CODING_AGENTS_SENTENCE = CODING_AGENTS.join(", ");
const THEME_KEY = "theme";
const WORKFLOW_CONTRACT_LANGUAGE_KEY = "workflow_contract_language";
const PUBLIC_ORIGIN_KEY = "public_origin";

export function theme(): Theme | null {
  const value = S.getInstanceSetting(THEME_KEY);
  return isTheme(value) ? value : null;
}

export function workflowContractLanguage(): WorkflowContractLanguage {
  const value = S.getInstanceSetting(WORKFLOW_CONTRACT_LANGUAGE_KEY);
  return value === "ja" ? "ja" : "en";
}

export function publicOrigin(): string | null {
  return S.getInstanceSetting(PUBLIC_ORIGIN_KEY) || null;
}

function validatePublicOrigin(value: unknown): asserts value is string | null {
  if (value === null) return;
  if (typeof value !== "string" || !value.trim()) {
    throw new ServiceError(
      422,
      "publicOrigin must be a valid HTTPS origin or null",
    );
  }
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.protocol !== "https:" ||
      parsed.origin !== trimmed ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error();
    }
  } catch {
    throw new ServiceError(
      422,
      "publicOrigin must be a valid HTTPS origin or null",
    );
  }
}

// The per-agent settings block for every runtime, derived from the registry order so a new runtime
// surfaces here without another hand-written entry. Both the resolved value and the raw override are
// reported: the Settings screen edits the override, while readers like the status bar want what a
// launch would actually use (#362).
function agentSettings(): Record<CodingAgent, AgentSettingsWire> {
  return Object.fromEntries(
    CODING_AGENTS.map((agent) => [
      agent,
      {
        model: agentModel(agent),
        effort: agentEffort(agent),
        modelOverride: agentModelOverride(agent),
        effortOverride: agentEffortOverride(agent),
      },
    ]),
  ) as Record<CodingAgent, AgentSettingsWire>;
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
  get(): GlobalSettingsWire {
    return {
      agents: agentSettings(),
      codingAgent: codingAgent(),
      devCostLimitUsd: devCostLimitUsd(),
      notificationSound: notificationSound(),
      theme: theme(),
      workflowContractLanguage: workflowContractLanguage(),
      publicOrigin: publicOrigin(),
    };
  },

  update(
    input: {
      // Which agent model/effort is being set for (#594, #682); required together with either.
      agent?: CodingAgent;
      // Default model this agent launches with when no explicit --model is passed (#594).
      model?: string;
      // Default effort paired with model in the Settings screen (#682).
      effort?: string;
      codingAgent?: CodingAgent;
      devCostLimitUsd?: number;
      // Whether the Web UI rings a bell for new notifications (#2508).
      notificationSound?: boolean;
      theme?: Theme;
      workflowContractLanguage?: WorkflowContractLanguage;
      publicOrigin?: string | null;
    },
    sessionId?: string | null,
  ): GlobalSettingsWire {
    // An empty model/effort is not a malformed value but the explicit "no override" choice the
    // Settings screen offers as Default: it removes the per-agent entry so the runtime registry
    // default applies again (#362).
    if (input.model !== undefined) {
      if (typeof input.model !== "string") {
        throw new ServiceError(422, "model must be a string");
      }
      validateAgentScopedSetting(input.agent);
    }
    if (input.effort !== undefined) {
      validateAgentScopedSetting(input.agent);
      if (typeof input.effort !== "string") {
        throw new ServiceError(422, "effort must be a string");
      }
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
      input.notificationSound !== undefined &&
      typeof input.notificationSound !== "boolean"
    ) {
      throw new ServiceError(422, "notificationSound must be a boolean");
    }
    if (input.theme !== undefined && !isTheme(input.theme)) {
      throw new ServiceError(422, "theme must be a supported theme");
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
    if (input.publicOrigin !== undefined)
      validatePublicOrigin(input.publicOrigin);

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
    if (input.notificationSound !== undefined) {
      updateNotificationSound(input.notificationSound);
    }
    // The config.json writes above are filesystem work and stay outside the transaction: only the
    // SQLite-backed settings and their event share a rollback boundary, so a failed DB write never
    // looks like it also reverted config.json.
    const actor = actorFor(sessionId);
    db.transaction(() => {
      if (input.theme !== undefined) {
        S.setInstanceSetting(THEME_KEY, input.theme);
      }
      if (input.workflowContractLanguage !== undefined) {
        S.setInstanceSetting(
          WORKFLOW_CONTRACT_LANGUAGE_KEY,
          input.workflowContractLanguage,
        );
      }
      if (input.publicOrigin !== undefined) {
        if (input.publicOrigin === null) {
          S.setInstanceSetting(PUBLIC_ORIGIN_KEY, "");
        } else {
          S.setInstanceSetting(PUBLIC_ORIGIN_KEY, input.publicOrigin.trim());
        }
      }
      S.emitEvent(null, "settings.updated", actor, input);
    });
    return settings.get();
  },
};
