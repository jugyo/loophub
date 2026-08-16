// The JSON-RPC contract: every method's params JSON Schema, a descriptive result
// schema, and the handler that maps to a core/service procedure. This is the single
// language-neutral surface — clients (S4) are written against these schemas and never
// import core types. The dispatcher (rpc.ts) compiles the params schemas with ajv and
// validates incoming params before calling the handler.
import { CODING_AGENTS } from "../../core/runtimes.ts";
import * as svc from "../../core/service.ts";
import { THEME_IDS } from "../../core/theme.ts";
import { log } from "./logger.ts";
import { webRuntimeConfig } from "./runtime-config.ts";

export const PROTOCOL_VERSION = "2026-08-02";
export const SERVER_INFO = { name: "loophub", version: "0.0.0" } as const;

// ---- reusable schema fragments ----
// Derived from the runtime registry so a new CodingAgent (e.g. OpenCode) is accepted on the
// wire without re-listing ids in every method schema.
const codingAgentEnum = { enum: [...CODING_AGENTS] } as const;
const str = { type: "string" } as const;
const strNonEmpty = { type: "string", minLength: 1 } as const;
const sid = { type: "string", minLength: 1 } as const;
const positiveNumber = { type: "number", exclusiveMinimum: 0 } as const;
const devCostLimitUsd = {
  ...positiveNumber,
  maximum: 1000,
  default: 10,
  description:
    "Per-task USD over-budget stop threshold for implementation agents. Omit to use the $10 default. JSON Schema enforces the positive and $1,000 maximum bounds; the service additionally rejects values with more than two decimal places.",
} as const;
const positiveInt = { type: "integer", minimum: 1 } as const;
const stringArray = { type: "array", items: { type: "string" } } as const;
// References collected from one Markdown body, grouped by the repo each points at. Both
// levels are bounded so a pathological body cannot turn a single lookup into an unbounded
// number of queries or SQL parameters.
const refNumberArray = {
  type: "array",
  items: positiveInt,
  maxItems: 200,
} as const;
const refTargetArray = {
  type: "array",
  maxItems: 50,
  items: {
    type: "object",
    properties: { repo: strNonEmpty, numbers: refNumberArray },
    required: ["repo", "numbers"],
    additionalProperties: false,
  },
} as const;
const strOrNull = { type: ["string", "null"] } as const;
const workflowFields = {
  description: str,
  execute_prompt: str,
  verify_prompt: str,
} as const;
const repo = strNonEmpty; // "owner/name" or bare "name"

// A params schema: object, listed properties, given required keys, no extras.
function params(
  properties: Record<string, unknown>,
  required: string[] = [],
): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
} {
  return { type: "object", properties, required, additionalProperties: false };
}

const EMPTY_PARAMS = params({});

// Loose result schemas — documented in the contract, not runtime-enforced.
const anyObject = { type: "object" } as const;
const anyArray = { type: "array" } as const;

export interface MethodDef {
  description: string;
  params: object;
  result: object;
  handler: (p: any) => unknown | Promise<unknown>;
}

export const methods: Record<string, MethodDef> = {
  initialize: {
    description:
      "Capability negotiation; returns protocol version, server info, and method list.",
    params: params({ protocolVersion: str, clientInfo: anyObject }),
    result: anyObject,
    handler: () => capabilities(),
  },

  // ---- repos ----
  "repos/create": {
    description: "Register a local git repository.",
    params: params({ path: strNonEmpty, name: strNonEmpty, session_id: sid }, [
      "path",
      "name",
    ]),
    result: anyObject,
    handler: (p) =>
      svc.repos.create({ path: p.path, name: p.name }, p.session_id),
  },
  "repos/list": {
    description: "List registered repositories.",
    params: params({ archived: { enum: ["active", "archived", "all"] } }),
    result: anyArray,
    handler: (p) => svc.repos.list(p.archived ?? "active"),
  },
  "repos/get": {
    description: "Get one repository by name.",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.get(p.name),
  },
  "repos/setArchived": {
    description: "Archive or unarchive a repository.",
    params: params(
      { name: repo, archived: { type: "boolean" }, session_id: sid },
      ["name", "archived"],
    ),
    result: anyObject,
    handler: (p) => svc.repos.setArchived(p.name, p.archived, p.session_id),
  },
  "repos/setFavorite": {
    description: "Favorite or unfavorite a repository.",
    params: params(
      { name: repo, favorite: { type: "boolean" }, session_id: sid },
      ["name", "favorite"],
    ),
    result: anyObject,
    handler: (p) => svc.repos.setFavorite(p.name, p.favorite, p.session_id),
  },
  "repos/update": {
    description: "Update a repository's default branch and/or local path.",
    params: params(
      {
        name: repo,
        default_branch: strNonEmpty,
        local_path: strNonEmpty,
        session_id: sid,
      },
      ["name"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.repos.update(
        p.name,
        { default_branch: p.default_branch, local_path: p.local_path },
        p.session_id,
      ),
  },

  "worker/status": {
    description:
      "Report whether the resident worker is present, fresh, and workflow-protocol compatible with this Web server.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.workerRuntime.status(),
  },
  "repos/rename": {
    description: "Rename a repository's owner/name (full_name) (#485).",
    params: params({ name: repo, new_name: strNonEmpty, session_id: sid }, [
      "name",
      "new_name",
    ]),
    result: anyObject,
    handler: (p) => svc.repos.rename(p.name, p.new_name, p.session_id),
  },
  "repos/setMergeMode": {
    description:
      "Pin the repo's PR-detail write action ('merge' | 'github_pr'), or 'auto' to clear it (#406).",
    params: params(
      {
        name: repo,
        mode: { enum: ["merge", "github_pr", "auto"] },
        session_id: sid,
      },
      ["name", "mode"],
    ),
    result: anyObject,
    handler: (p) => svc.repos.setMergeMode(p.name, p.mode, p.session_id),
  },
  "repos/mergeMode": {
    description:
      "Resolved merge-mode view: raw setting, GitHub-remote presence, and the effective mode (#406).",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.mergeMode(p.name),
  },
  "repos/originSync": {
    description:
      "How the repo's checkout stands against origin: origin presence, the checked-out branch, and its ahead/behind counts against origin/<branch>. Reads local refs only — it does not fetch (#71).",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.originSync(p.name),
  },
  "repos/pullFromOrigin": {
    description:
      "Run `git pull --ff-only origin <branch>` in the repo's checkout and return the refreshed origin sync state (#71).",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.pullFromOrigin(p.name),
  },
  "repos/fetchFromOrigin": {
    description:
      "Run `git fetch origin` in the repo's checkout and return the refreshed origin sync state. Only remote-tracking refs move — the working tree and the checked-out branch are untouched, so it also works on a detached HEAD.",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.fetchFromOrigin(p.name),
  },
  "repos/setAgentConfig": {
    description:
      "Set the repo's Coding agent override: toggle plus runtime/model/effort, or falls back to app defaults when off (#1532).",
    params: params(
      {
        name: repo,
        override: { type: "boolean" },
        runtime: codingAgentEnum,
        model: strOrNull,
        effort: strOrNull,
        session_id: sid,
      },
      ["name", "override"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.repos.setAgentConfig(
        p.name,
        {
          override: p.override,
          runtime: p.runtime,
          model: p.model,
          effort: p.effort,
        },
        p.session_id,
      ),
  },
  "repos/agentConfig": {
    description:
      "Resolved Coding agent view: raw per-repo override (toggle + runtime/model/effort) and the effective config a run launches with (#1532).",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.agentConfig(p.name),
  },
  "repos/githubPrExportExtraPrompt": {
    description:
      "Per-repo additional text appended to the Create PR on GitHub agent prompt; null when unset (#2422).",
    params: params({ name: repo }, ["name"]),
    result: anyObject,
    handler: (p) => svc.repos.githubPrExportExtraPrompt(p.name),
  },
  "repos/setGithubPrExportExtraPrompt": {
    description:
      "Set or clear the repo's additional Create PR on GitHub prompt text. Empty string or null clears it (#2422).",
    params: params(
      {
        name: repo,
        extra_prompt: strOrNull,
        session_id: sid,
      },
      ["name", "extra_prompt"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.repos.setGithubPrExportExtraPrompt(
        p.name,
        p.extra_prompt,
        p.session_id,
      ),
  },

  // ---- global settings ----
  "settings/get": {
    description:
      "Instance-level settings (per-agent model/effort, codingAgent, devCostLimitUsd, theme, workflowContractLanguage).",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.settings.get(),
  },
  "settings/update": {
    description:
      "Update instance-level settings. model/effort require agent; theme and workflowContractLanguage are DB-backed.",
    params: params({
      agent: codingAgentEnum,
      model: strNonEmpty,
      // Runtime-specific validation remains in the settings service.
      effort: str,
      codingAgent: codingAgentEnum,
      devCostLimitUsd,
      theme: { enum: THEME_IDS },
      workflowContractLanguage: { enum: ["en", "ja"] },
      session_id: sid,
    }),
    result: anyObject,
    handler: (p) =>
      svc.settings.update(
        {
          agent: p.agent,
          model: p.model,
          effort: p.effort,
          codingAgent: p.codingAgent,
          devCostLimitUsd: p.devCostLimitUsd,
          theme: p.theme,
          workflowContractLanguage: p.workflowContractLanguage,
        },
        p.session_id,
      ),
  },

  // ---- notifications ----
  "notifications/list": {
    description: "List notification-stack alerts.",
    params: params({ limit: positiveInt, unreadOnly: { type: "boolean" } }),
    result: anyArray,
    handler: (p) =>
      svc.notifications.list({
        limit: p.limit,
        unreadOnly: p.unreadOnly,
      }),
  },
  "notifications/unreadCount": {
    description: "Count unread notification-stack alerts.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.notifications.unreadCount(),
  },
  "notifications/read": {
    description: "Mark one notification-stack alert as read.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.notifications.read(p.id, p.session_id),
  },
  "notifications/readAll": {
    description: "Mark all notification-stack alerts as read.",
    params: params({ session_id: sid }),
    result: anyObject,
    handler: (p) => svc.notifications.readAll(p.session_id),
  },

  // ---- workflows ----
  "workflows/contracts": {
    description:
      "Get a run's fixed system prompts: the parent contract plus the Execute/Verify step contracts.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.workflows.contracts(),
  },
  "workflows/list": {
    description:
      "List workflow definitions in one management scope or applicable to one repository.",
    params: params({ repo, applicable_to_repo: repo }),
    result: anyArray,
    handler: (p) =>
      svc.workflows.list({
        scope: p.repo ? { repo: p.repo } : undefined,
        applicableTo: p.applicable_to_repo,
      }),
  },
  "workflows/create": {
    description: "Create a global or repository-scoped workflow definition.",
    params: params(
      { name: strNonEmpty, repo, ...workflowFields, session_id: sid },
      ["name"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.workflows.create(
        {
          name: p.name,
          description: p.description,
          execute_prompt: p.execute_prompt,
          verify_prompt: p.verify_prompt,
          repo: p.repo,
        },
        p.session_id,
      ),
  },
  "workflows/update": {
    description: "Update a workflow definition by id.",
    params: params(
      {
        id: positiveInt,
        new_name: strNonEmpty,
        ...workflowFields,
        session_id: sid,
      },
      ["id"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.workflows.updateById(
        p.id,
        {
          name: p.new_name,
          description: p.description,
          execute_prompt: p.execute_prompt,
          verify_prompt: p.verify_prompt,
        },
        p.session_id,
      ),
  },
  "workflows/archive": {
    description: "Archive a workflow definition by id.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.workflows.archiveById(p.id, p.session_id),
  },
  "workflows/delete": {
    description:
      "Delete a workflow definition by id unless a running run references it.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.workflows.deleteById(p.id, p.session_id),
  },
  "workflowRuns/stateForIssue": {
    description:
      "Display state of the latest Workflow run linked to an issue, including canonical pre-merge Done and conflict state, or null when none.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.workflowRuns.stateForIssue(p.repo, { issue: p.number }),
  },
  "workflowRuns/stateForPull": {
    description:
      "Display state of the latest Workflow run linked to a PR, including canonical pre-merge Done and conflict state, or null when none.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.workflowRuns.stateForPull(p.repo, { pull: p.number }),
  },
  "workflowRuns/history": {
    description:
      "List persisted lifecycle events for one Workflow run, oldest first and scoped by run id.",
    params: params({ repo, run: positiveInt }, ["repo", "run"]),
    result: anyArray,
    handler: (p) => svc.workflowRuns.history(p.repo, { run: p.run }),
  },
  "workflowRuns/agentCosts": {
    description:
      "List the persisted agent sessions that participated in one Workflow run and each session's current cost.",
    params: params({ repo, run: positiveInt }, ["repo", "run"]),
    result: anyArray,
    handler: (p) => svc.workflowRuns.agentCosts(p.repo, { run: p.run }),
  },
  "workflowRuns/totalCost": {
    description:
      "Return the current total cost and observation status for one Workflow run.",
    params: params({ repo, run: positiveInt }, ["repo", "run"]),
    result: anyObject,
    handler: (p) => svc.workflowRuns.totalCost(p.repo, { run: p.run }),
  },
  "workflowRuns/increaseCostLimit": {
    description:
      "Increase a cost-held Workflow run's limit by its persisted fixed increment. The emitted event is the human continuation decision the parent resumes from (#1828).",
    params: params(
      {
        repo,
        run: positiveInt,
        expected_limit_usd: positiveNumber,
        session_id: sid,
      },
      ["repo", "run", "expected_limit_usd", "session_id"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.workflowRuns.increaseCostLimitForHuman(
        p.repo,
        { run: p.run, expectedLimitUsd: p.expected_limit_usd },
        p.session_id,
      ),
  },
  "workflowRuns/increaseReworkLimit": {
    description:
      "Increase a rework-held Workflow run's limit by its current fixed limit.",
    params: params(
      {
        repo,
        run: positiveInt,
        expected_limit: positiveInt,
        session_id: sid,
      },
      ["repo", "run", "expected_limit", "session_id"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.workflowRuns.increaseReworkLimitForHuman(
        p.repo,
        { run: p.run, expectedLimit: p.expected_limit },
        p.session_id,
      ),
  },

  // ---- terminal launch ----
  "terminal/launch": {
    description:
      "Launch a terminal workflow as a named Herdr session. workflow-run (Start workflow) spawns `lh workflow start --herdr` and lets it provision the worktree/PR and the herdr pane itself (#1007); the other workflows are orchestrated by this RPC directly.",
    params: params(
      {
        repo,
        label: str,
        workflow: {
          enum: [
            "issue-create",
            "workflow-create",
            "github-pr-export",
            "workflow-run",
          ],
        },
        issueNumber: positiveInt,
        prNumber: positiveInt,
        // Saved workflow id for the "workflow-run" launch (#1007) — passed to
        // `lh workflow start ... --workflow-id <id>`. Required only for that workflow.
        workflowId: positiveInt,
        targetBranch: str,
        prompt: str,
        // One-shot launch overrides (#1275/#1534): force the runtime / model / effort for New
        // issue, or runtime / model for Start workflow, without changing persisted settings.
        agent: codingAgentEnum,
        model: str,
        effort: str,
      },
      // `repo` is required for every workflow except the global "workflow-create" (New workflow),
      // which has no repo to pin to (#1889); the service enforces the requirement per-workflow.
      [],
    ),
    result: anyObject,
    handler: (p) =>
      svc.terminal.launch(
        {
          repo: p.repo,
          label: p.label,
          workflow: p.workflow,
          issueNumber: p.issueNumber,
          prNumber: p.prNumber,
          workflowId: p.workflowId,
          targetBranch: p.targetBranch,
          prompt: p.prompt,
          agent: p.agent,
          model: p.model,
          effort: p.effort,
        },
        log.error,
      ),
  },

  "terminal/sessions": {
    description:
      "Running herdr sessions grouped by repository, with each agent's name and status (#495), plus which running agents are pinned to a PR's worktree (pull_workspaces, #579 — drives the issue-list Herdr badge). running_repos independently lists repos whose session was confirmed running, including sessions with no visible agents; it is absent when session state could not be read.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.terminal.sessions(),
  },
  "terminal/agentRead": {
    description:
      "Recent terminal output for one herdr agent, for the sidebar hover preview (#500). target is a herdr `agent read` target — a pane_id, or an agent display name (e.g. \"dev #486\") only when it's unique within the session (herdr will not resolve an ambiguous name). output is null when herdr isn't running, the session is gone, or the agent is no longer present.",
    params: params({ repo, target: strNonEmpty, lines: positiveInt }, [
      "repo",
      "target",
    ]),
    result: anyObject,
    handler: (p) =>
      svc.terminal.agentRead({
        repo: p.repo,
        target: p.target,
        lines: p.lines,
      }),
  },

  "terminal/killAgent": {
    description:
      "Close the pane a herdr agent is running in, identified by its pane id (#521). Fails visibly (herdr not installed, session/pane already gone) rather than silently.",
    params: params({ repo, paneId: strNonEmpty }, ["repo", "paneId"]),
    result: anyObject,
    handler: (p) => svc.terminal.killAgent({ repo: p.repo, paneId: p.paneId }),
  },
  "terminal/focusAgent": {
    description:
      "Switch herdr's focus to a running agent's pane, identified by its pane id (#578's herdr agent focus, reused by the issue-list Herdr badge's click action, #579). Fails visibly (herdr not installed, pane already gone) rather than silently.",
    params: params({ repo, paneId: strNonEmpty }, ["repo", "paneId"]),
    result: anyObject,
    handler: (p) => svc.terminal.focusAgent({ repo: p.repo, paneId: p.paneId }),
  },
  "terminal/sendAgentInput": {
    description:
      "Send one literal text input to the live Herdr agent whose pane is currently mapped to the requested PR worktree, then submit it once. The service revalidates repo, PR, and pane before writing.",
    params: params(
      { repo, pull: positiveInt, paneId: strNonEmpty, text: strNonEmpty },
      ["repo", "pull", "paneId", "text"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.terminal.sendAgentInput({
        repo: p.repo,
        pull: p.pull,
        paneId: p.paneId,
        text: p.text,
      }),
  },

  // ---- agent sessions ----
  "sessions/list": {
    description: "List agent sessions.",
    params: EMPTY_PARAMS,
    result: anyArray,
    handler: () => svc.sessions.list(),
  },
  "sessions/costSummary": {
    description:
      "Small per-coding-agent cost totals for topbar display, grouped by month/week/today.",
    params: EMPTY_PARAMS,
    result: anyArray,
    handler: () => svc.sessions.costSummary(),
  },

  // ---- issues ----
  "issues/list": {
    description: "List issues/PRs in a repository.",
    params: params(
      {
        repo,
        state: str,
        kind: { enum: ["issue", "pull", "any"] },
        labels: stringArray,
        workspace: str,
        lookahead: { type: "boolean" },
        page: positiveInt,
        perPage: positiveInt,
        sort: { enum: ["updated", "created"] },
      },
      ["repo"],
    ),
    result: anyArray,
    handler: (p) =>
      svc.issues.list(p.repo, {
        state: p.state,
        kind: p.kind,
        labels: p.labels,
        workspace: p.workspace,
        lookahead: p.lookahead,
        page: p.page,
        perPage: p.perPage,
        sort: p.sort,
      }),
  },
  "pageData/issueList": {
    description:
      "Get the issue list and its repository, workspace, and optional filter data in one request.",
    params: params(
      {
        repo,
        state: str,
        labels: stringArray,
        workspace: str,
        lookahead: { type: "boolean" },
        page: positiveInt,
        perPage: positiveInt,
        includeLabels: { type: "boolean" },
      },
      ["repo"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pageData.issueList(p.repo, {
        state: p.state,
        labels: p.labels,
        workspace: p.workspace,
        lookahead: p.lookahead,
        page: p.page,
        perPage: p.perPage,
        includeLabels: p.includeLabels,
      }),
  },
  "search/query": {
    description: "Search issues and pull requests in a repository.",
    params: params({ repo, query: strNonEmpty }, ["repo", "query"]),
    result: anyArray,
    handler: (p) => svc.search.query(p.repo, p.query),
  },
  "workspaces/list": {
    description: "List registered workspaces in a repository.",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.workspaces.list(p.repo),
  },
  "workspaces/listArchived": {
    description: "List archived workspaces in a repository.",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.workspaces.listArchived(p.repo),
  },
  "workspaces/listForSettings": {
    description:
      "List registered workspaces for repository settings, excluding the default branch.",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.workspaces.listForSettings(p.repo),
  },
  "workspaces/listArchivedForSettings": {
    description:
      "List archived workspaces for repository settings, excluding the default branch.",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.workspaces.listArchivedForSettings(p.repo),
  },
  "workspaces/create": {
    description: "Create and register a workspace branch.",
    params: params({ repo, branch: strNonEmpty, session_id: sid }, [
      "repo",
      "branch",
    ]),
    result: anyObject,
    handler: (p) =>
      svc.workspaces.create(p.repo, { branch: p.branch }, p.session_id),
  },
  "workspaces/archive": {
    description: "Archive a registered workspace.",
    params: params({ repo, branch: strNonEmpty, session_id: sid }, [
      "repo",
      "branch",
    ]),
    result: anyObject,
    handler: (p) => svc.workspaces.archive(p.repo, p.branch, p.session_id),
  },
  "workspaces/unarchive": {
    description: "Restore an archived workspace.",
    params: params({ repo, branch: strNonEmpty, session_id: sid }, [
      "repo",
      "branch",
    ]),
    result: anyObject,
    handler: (p) => svc.workspaces.unarchive(p.repo, p.branch, p.session_id),
  },
  "issues/get": {
    description: "Get one issue by number.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.issues.get(p.repo, p.number),
  },
  "issues/refKinds": {
    description:
      "Classify referenced numbers as issue or pull, per repo they point at. Unregistered repos and numbers absent from a repo are omitted.",
    params: params({ targets: refTargetArray }, ["targets"]),
    result: anyArray,
    handler: (p) => svc.issues.refKinds(p.targets),
  },
  "pageData/issueDetail": {
    description: "Get all initial data for one issue-detail screen.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.pageData.issueDetail(p.repo, p.number, "me"),
  },
  "issues/ac/list": {
    description:
      "List all acceptance criteria for an issue, including disabled criteria.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.issues.acList(p.repo, p.number),
  },
  "issues/ac/add": {
    description: "Add an acceptance criterion to an issue.",
    params: params({ repo, number: positiveInt, text: strNonEmpty }, [
      "repo",
      "number",
      "text",
    ]),
    result: anyObject,
    handler: (p) => svc.issues.acAdd(p.repo, p.number, p.text),
  },
  "issues/ac/setEnabled": {
    description: "Enable or disable an issue's acceptance criterion.",
    params: params(
      {
        repo,
        number: positiveInt,
        criterion_id: strNonEmpty,
        enabled: { type: "boolean" },
      },
      ["repo", "number", "criterion_id", "enabled"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issues.acSetEnabled(p.repo, p.criterion_id, p.enabled, p.number),
  },
  "issues/create": {
    description: "Open a new issue.",
    params: params(
      {
        repo,
        title: strNonEmpty,
        body: str,
        labels: stringArray,
        target_branch: strOrNull,
        parent: positiveInt,
        session_id: sid,
      },
      ["repo", "title"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issues.create(
        p.repo,
        {
          title: p.title,
          body: p.body,
          labels: p.labels,
          target_branch: p.target_branch,
          parent: p.parent,
        },
        p.session_id,
      ),
  },
  "issues/update": {
    description: "Edit an issue's title/body/state/labels/target workspace.",
    params: params(
      {
        repo,
        number: positiveInt,
        title: str,
        body: str,
        state: { enum: ["open", "closed"] },
        labels: stringArray,
        workspace: strOrNull,
        target_branch: strOrNull,
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issues.update(
        p.repo,
        p.number,
        {
          title: p.title,
          body: p.body,
          state: p.state,
          labels: p.labels,
          workspace: p.workspace,
          target_branch: p.target_branch,
        },
        p.session_id,
      ),
  },

  // ---- comments ----
  "comments/list": {
    description: "List an issue's comments.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.comments.list(p.repo, p.number, "me"),
  },
  "comments/create": {
    description: "Add a human comment to an issue.",
    params: params({ repo, number: positiveInt, body: strNonEmpty }, [
      "repo",
      "number",
      "body",
    ]),
    result: anyObject,
    handler: (p) => svc.comments.createHumanForIssue(p.repo, p.number, p.body),
  },
  "pullComments/create": {
    description: "Add a human comment to a pull request.",
    params: params({ repo, number: positiveInt, body: strNonEmpty }, [
      "repo",
      "number",
      "body",
    ]),
    result: anyObject,
    handler: (p) => svc.comments.createHumanForPull(p.repo, p.number, p.body),
  },
  "pullComments/react": {
    description: "Toggle a human emoji reaction on a pull request comment.",
    params: params(
      {
        repo,
        number: positiveInt,
        comment_id: positiveInt,
        emoji: strNonEmpty,
      },
      ["repo", "number", "comment_id", "emoji"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.comments.reactHumanForPull(p.repo, p.number, p.comment_id, p.emoji),
  },
  "pullComments/archive": {
    description:
      "Archive or unarchive a pull request comment, keeping it collapsed on the PR page.",
    params: params(
      {
        repo,
        number: positiveInt,
        comment_id: positiveInt,
        archived: { type: "boolean" },
      },
      ["repo", "number", "comment_id", "archived"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.comments.setArchivedForPull(
        p.repo,
        p.number,
        p.comment_id,
        p.archived,
      ),
  },

  // ---- handoffs (#352) ----
  "handoffs/list": {
    description:
      "List orchestrator<->subagent handoffs for a ref, chronological (seq asc). Filters optional: pr narrows to one PR, issue to a generic issue, session to a session.",
    params: params(
      { repo, pr: positiveInt, issue: positiveInt, session: sid },
      ["repo"],
    ),
    result: anyArray,
    handler: (p) =>
      svc.handoffs.list(p.repo, {
        pr: p.pr,
        issue: p.issue,
        session: p.session,
      }),
  },

  // ---- labels ----
  "labels/list": {
    description: "List a repository's labels.",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.labels.list(p.repo),
  },

  // ---- pulls ----
  "pulls/list": {
    description: "List pull requests in a repository.",
    params: params(
      {
        repo,
        state: str,
        merged: { enum: ["only", "exclude"] },
        head: str,
        base: str,
        page: positiveInt,
        perPage: positiveInt,
      },
      ["repo"],
    ),
    result: anyArray,
    handler: (p) =>
      svc.pulls.list(p.repo, {
        state: p.state,
        merged: p.merged ?? null,
        head: p.head,
        base: p.base,
        page: p.page,
        perPage: p.perPage,
      }),
  },
  "pulls/get": {
    description: "Get one pull request by number.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.pulls.get(p.repo, p.number),
  },
  "pulls/usage": {
    description: "Get a pull request's agent usage totals (tokens/cost).",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.pulls.usage(p.repo, p.number),
  },
  "pageData/pullDetail": {
    description: "Get all initial data for one pull-request detail screen.",
    // session_id names the reader for the diff feedback this page carries, the same way
    // diffFeedback/list does — without it a reader's own reactions come back unreacted.
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) =>
      svc.pageData.pullDetail(p.repo, p.number, "me", p.session_id),
  },
  "pulls/update": {
    description: "Edit a pull request's title/body/state.",
    params: params(
      {
        repo,
        number: positiveInt,
        state: { enum: ["open", "closed"] },
        title: str,
        body: str,
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.update(
        p.repo,
        p.number,
        { state: p.state, title: p.title, body: p.body },
        p.session_id,
      ),
  },
  "pulls/archive": {
    description: "Archive a pull request while preserving its history.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.archive(p.repo, p.number, p.session_id),
  },
  "pulls/unarchive": {
    description: "Restore an archived pull request to active result sets.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.unarchive(p.repo, p.number, p.session_id),
  },
  "pulls/files": {
    description: "List a pull request's changed files (diff).",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.pulls.files(p.repo, p.number),
  },
  "pulls/diff": {
    description:
      "Get a stable PR diff with its exact commit pair and line coordinates.",
    params: params(
      {
        repo,
        number: positiveInt,
        path: str,
        ignore_whitespace: { type: "boolean" },
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.diff(p.repo, p.number, p.path, p.ignore_whitespace),
  },
  "diffFeedback/list": {
    description: "List diff feedback threads for a pull request.",
    params: params(
      {
        repo,
        number: positiveInt,
        path: str,
        orphaned: { type: "boolean" },
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.diffFeedback.list(
        p.repo,
        p.number,
        {
          path: p.path,
          orphaned: p.orphaned,
        },
        p.session_id,
      ),
  },
  "diffFeedback/get": {
    description: "Get one diff feedback thread.",
    params: params({ repo, number: positiveInt, thread_id: positiveInt }, [
      "repo",
      "number",
      "thread_id",
    ]),
    result: anyObject,
    handler: (p) => svc.diffFeedback.get(p.repo, p.number, p.thread_id),
  },
  "diffFeedback/create": {
    description: "Create a human diff-anchored feedback thread.",
    params: params(
      {
        repo,
        number: positiveInt,
        base_sha: strNonEmpty,
        head_sha: strNonEmpty,
        path: strNonEmpty,
        side: { enum: ["LEFT", "RIGHT"] },
        start_line: positiveInt,
        end_line: positiveInt,
        body: strNonEmpty,
      },
      [
        "repo",
        "number",
        "base_sha",
        "head_sha",
        "path",
        "side",
        "start_line",
        "end_line",
        "body",
      ],
    ),
    result: anyObject,
    handler: (p) =>
      svc.diffFeedback.createHuman(p.repo, p.number, {
        baseSha: p.base_sha,
        headSha: p.head_sha,
        path: p.path,
        side: p.side,
        startLine: p.start_line,
        endLine: p.end_line,
        body: p.body,
      }),
  },
  "diffFeedback/reply": {
    description: "Add a human reply to a diff feedback conversation.",
    params: params(
      {
        repo,
        number: positiveInt,
        thread_id: positiveInt,
        body: strNonEmpty,
      },
      ["repo", "number", "thread_id", "body"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.diffFeedback.replyHuman(p.repo, p.number, p.thread_id, p.body),
  },
  "diffFeedback/archive": {
    description:
      "Archive or unarchive a diff feedback conversation, keeping it collapsed in the diff view.",
    params: params(
      {
        repo,
        number: positiveInt,
        thread_id: positiveInt,
        archived: { type: "boolean" },
      },
      ["repo", "number", "thread_id", "archived"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.diffFeedback.archive(p.repo, p.number, p.thread_id, p.archived),
  },
  "diffFeedback/react": {
    description: "Add an emoji reaction to a diff feedback message.",
    params: params(
      {
        repo,
        number: positiveInt,
        message_id: positiveInt,
        emoji: strNonEmpty,
        session_id: sid,
      },
      ["repo", "number", "message_id", "emoji"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.diffFeedback.react(
        p.repo,
        p.number,
        p.message_id,
        p.emoji,
        p.session_id,
      ),
  },
  "repos/commitFiles": {
    description:
      "List files changed by one repository commit, compared with its first parent.",
    params: params({ repo, sha: strNonEmpty }, ["repo", "sha"]),
    result: anyArray,
    handler: (p) => svc.repos.commitFiles(p.repo, p.sha),
  },
  "pulls/fileAtRef": {
    description:
      "Whole-file content of a changed file at the PR's base or head commit (#435), for the Markdown preview modal. `status` is 'ok' (with `content`), 'missing' (the file does not exist at that side — an added or deleted file), or 'binary'.",
    params: params(
      {
        repo,
        number: positiveInt,
        path: strNonEmpty,
        side: { enum: ["base", "head"] },
      },
      ["repo", "number", "path", "side"],
    ),
    result: anyObject,
    handler: (p) => svc.pulls.fileAtRef(p.repo, p.number, p.path, p.side),
  },
  "pulls/merge": {
    description: "Merge a pull request.",
    params: params(
      {
        repo,
        number: positiveInt,
        merge_method: { enum: ["squash", "merge", "rebase"] },
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.merge(
        p.repo,
        p.number,
        p.merge_method ?? "squash",
        p.session_id,
      ),
  },
  "pulls/markGithubMerged": {
    description:
      "Mark an open pull request as merged after its linked GitHub merge has been detected.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.markGithubMerged(p.repo, p.number, p.session_id),
  },
  "pulls/createGithubPull": {
    description:
      "External agent surface (not used by the SPA). Submit a loophub PR to GitHub as a Draft PR (#411): push the head branch under `branch`, open (or recover) a Draft PR, and record it. Atomic — a retry recovers a created-but-unrecorded PR instead of duplicating. Same core orchestration as `lh pr create-github-pr`.",
    params: params(
      {
        repo,
        number: positiveInt,
        branch: strNonEmpty,
        title: strNonEmpty,
        body: strNonEmpty,
        session_id: sid,
      },
      ["repo", "number", "branch", "title", "body"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.createGithubPull(
        p.repo,
        p.number,
        { branch: p.branch, title: p.title, body: p.body },
        p.session_id,
      ),
  },
  "pulls/pushGithubPull": {
    description:
      "Push the loophub PR's current head to the branch of its already-recorded GitHub PR (#848), so commits added locally after the export reach GitHub without re-creating the PR. Records the pushed head SHA. `force` (#1861) pushes with `--force-with-lease` for a head rewritten by rebase/amend.",
    params: params(
      {
        repo,
        number: positiveInt,
        force: { type: "boolean" },
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.pushGithubPull(
        p.repo,
        p.number,
        { force: p.force },
        p.session_id,
      ),
  },
  "pulls/unlinkGithubPull": {
    description:
      "Remove the GitHub PR link recorded on a loophub PR (#2384), so a wrong link can be corrected or a GitHub PR created again. Only the LoopHub-side link (and its cached GitHub status) is dropped; the GitHub PR itself is untouched. 409 when the PR has no linked GitHub PR.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.unlinkGithubPull(p.repo, p.number, p.session_id),
  },
  "pulls/githubStatus": {
    description:
      "GitHub-side status (draft / review / checks / comment counts / merged) of a PR's linked GitHub PR (#850). Fetched on demand via `gh` and cached; 404 when the PR has no linked GitHub PR.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.pulls.githubStatus(p.repo, p.number),
  },
  "pulls/debug": {
    description:
      "Read-only debug dump for a PR: raw DB rows (issue/pull/linked issue/labels), git facts (refs, SHAs, diffstat, commits, files), reviews, comments, related events, and the dev session.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.pulls.debug(p.repo, p.number),
  },
  // ---- reviews ----
  "reviews/list": {
    description: "List a pull request's reviews.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.reviews.list(p.repo, p.number),
  },
  "reviews/listComments": {
    description: "List a pull request's line comments.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.reviews.listComments(p.repo, p.number),
  },

  // ---- events ----
  "events/list": {
    description: "Poll events (webhook-style) by id cursor.",
    params: params({
      since: { type: "integer", minimum: 0 },
      repo,
      labels: stringArray,
      types: stringArray,
      runId: { type: "integer" },
      order: { enum: ["asc", "desc"] },
      limit: positiveInt,
    }),
    result: anyArray,
    handler: (p) =>
      svc.events.list({
        since: p.since,
        repo: p.repo,
        labels: p.labels,
        types: p.types,
        runId: p.runId,
        order: p.order,
        limit: p.limit,
      }),
  },

  // ---- dashboard ----
  "dashboard/overview": {
    description:
      "Cross-repo top-page overview: recently created open issues, each tagged with its repo.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.dashboard.overview(),
  },

  // ---- stats ----
  "stats/get": {
    description:
      "Database statistics: per-table row counts, DB file size (WAL included), and per-repo issue/PR tallies.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.stats.get(),
  },

  // ---- sync ----
  "sync/run": {
    description:
      "External / manual surface (not used by the SPA). Sweep open-PR heads and emit pull_request.updated when a head moved. Kept alongside `lh sync` so operators can force a sweep outside the worker poll loop (see worker/maintenance.ts).",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.sync.run(),
  },
};

export function capabilities() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    capabilities: {
      methods: Object.keys(methods).sort(),
      notifications: [],
    },
    webConfig: webRuntimeConfig(),
  };
}

// Language-neutral contract document (JSON Schema based). Safe to serialize and ship to
// non-TS clients or emit as a static artifact.
export function contractDocument() {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverInfo: SERVER_INFO,
    methods: Object.entries(methods).map(([name, m]) => ({
      name,
      description: m.description,
      params: m.params,
      result: m.result,
    })),
    notifications: [],
  };
}
