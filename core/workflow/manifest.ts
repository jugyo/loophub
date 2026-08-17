import { ServiceError } from "../errors.ts";
import { type CodingAgent, isCodingAgent } from "../runtimes.ts";

export const WORKFLOW_MANIFEST_VERSION = 1 as const;
export const WORKFLOW_MANIFEST_LANGUAGES = ["en", "ja"] as const;
export type WorkflowManifestLanguage =
  (typeof WORKFLOW_MANIFEST_LANGUAGES)[number];

export type WorkflowManifestAgent = {
  runtime: CodingAgent;
  model: string;
  effort: string;
};

export type WorkflowManifest = {
  manifest_version: typeof WORKFLOW_MANIFEST_VERSION;
  contract_language: WorkflowManifestLanguage;
  agents: {
    parent: WorkflowManifestAgent;
    execute: WorkflowManifestAgent;
    verify: WorkflowManifestAgent;
  };
  prompts: {
    execute: string;
    verify: string;
  };
};

const MANIFEST_KEYS = [
  "manifest_version",
  "contract_language",
  "agents",
  "prompts",
] as const;
const AGENT_KINDS = ["parent", "execute", "verify"] as const;
const AGENT_KEYS = ["runtime", "model", "effort"] as const;
const PROMPT_KEYS = ["execute", "verify"] as const;

function invalid(message: string): never {
  throw new ServiceError(422, message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${field} は object でなければなりません`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) invalid(`${field}.${key} は未知の key です`);
  }
  for (const key of allowed) {
    if (!(key in value)) invalid(`${field}.${key} がありません`);
  }
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    invalid(`${field} は空でない string でなければなりません`);
  }
  return value;
}

function parseAgent(value: unknown, field: string): WorkflowManifestAgent {
  const agent = record(value, field);
  exactKeys(agent, AGENT_KEYS, field);

  const runtime = agent.runtime;
  if (!isCodingAgent(runtime)) {
    invalid(`${field}.runtime は未知の runtime です`);
  }
  return {
    runtime,
    model: nonEmptyString(agent.model, `${field}.model`),
    effort:
      typeof agent.effort === "string"
        ? agent.effort
        : invalid(`${field}.effort は string でなければなりません`),
  };
}

function parsePrompt(value: unknown, field: string): string {
  const prompt = nonEmptyString(value, field);
  if (!/^[^/\\\u0000-\u001f]+\.md$/.test(prompt) || prompt === ".md") {
    invalid(
      `${field} は run ディレクトリ直下の .md ファイル名でなければなりません`,
    );
  }
  return prompt;
}

export function parseWorkflowManifest(text: string): WorkflowManifest {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalid(`manifest は JSON として不正です`);
  }

  const root = record(value, "manifest");
  exactKeys(root, MANIFEST_KEYS, "manifest");
  if (root.manifest_version !== WORKFLOW_MANIFEST_VERSION) {
    invalid(
      `manifest.manifest_version は ${WORKFLOW_MANIFEST_VERSION} でなければなりません`,
    );
  }
  if (root.contract_language !== "en" && root.contract_language !== "ja") {
    invalid(`manifest.contract_language は en または ja でなければなりません`);
  }

  const agents = record(root.agents, "manifest.agents");
  exactKeys(agents, AGENT_KINDS, "manifest.agents");
  const parsedAgents = Object.fromEntries(
    AGENT_KINDS.map((kind) => [
      kind,
      parseAgent(agents[kind], `manifest.agents.${kind}`),
    ]),
  ) as WorkflowManifest["agents"];
  const runtime = parsedAgents.parent.runtime;
  for (const kind of AGENT_KINDS) {
    if (parsedAgents[kind].runtime !== runtime) {
      invalid(
        `manifest.agents.${kind}.runtime は parent と一致しなければなりません`,
      );
    }
  }

  const prompts = record(root.prompts, "manifest.prompts");
  exactKeys(prompts, PROMPT_KEYS, "manifest.prompts");
  return {
    manifest_version: WORKFLOW_MANIFEST_VERSION,
    contract_language: root.contract_language,
    agents: parsedAgents,
    prompts: {
      execute: parsePrompt(prompts.execute, "manifest.prompts.execute"),
      verify: parsePrompt(prompts.verify, "manifest.prompts.verify"),
    },
  };
}

export function serializeWorkflowManifest(manifest: WorkflowManifest): string {
  const orderedAgent = (agent: WorkflowManifestAgent) => ({
    runtime: agent.runtime,
    model: agent.model,
    effort: agent.effort,
  });
  const ordered = {
    manifest_version: manifest.manifest_version,
    contract_language: manifest.contract_language,
    agents: {
      parent: orderedAgent(manifest.agents.parent),
      execute: orderedAgent(manifest.agents.execute),
      verify: orderedAgent(manifest.agents.verify),
    },
    prompts: {
      execute: manifest.prompts.execute,
      verify: manifest.prompts.verify,
    },
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
