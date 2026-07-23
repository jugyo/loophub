// The JSON-RPC contract: every method's params JSON Schema, a descriptive result
// schema, and the handler that maps to a core/service procedure. This is the single
// language-neutral surface — clients (S4) are written against these schemas and never
// import core types. The dispatcher (rpc.ts) compiles the params schemas with ajv and
// validates incoming params before calling the handler.
import * as svc from "../../core/service.ts";
import { webRuntimeConfig } from "./runtime-config.ts";

export const PROTOCOL_VERSION = "2026-07-11";
export const SERVER_INFO = { name: "loophub", version: "0.0.0" } as const;

// ---- reusable schema fragments ----
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
// A model/effort override that may be explicitly cleared: a string, or null to fall back to the
// per-agent application default (#880 scheduled tasks).
const strOrNull = { type: ["string", "null"] } as const;
// The coding agent a scheduled task launches (#880).
const scheduledAgent = {
  type: "string",
  enum: ["claude-code", "codex"],
} as const;
const workflowFields = {
  description: str,
  execute_prompt: str,
  verify_prompt: str,
} as const;
const inboxMessageState = {
  type: "string",
  enum: ["unread", "read", "archived", "deleted"],
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
  "repos/setAgentConfig": {
    description:
      "Set the repo's Coding agent override: toggle plus runtime/model/effort, or falls back to app defaults when off (#1532).",
    params: params(
      {
        name: repo,
        override: { type: "boolean" },
        runtime: { enum: ["claude-code", "codex", "grok"] },
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

  // ---- global settings ----
  "settings/get": {
    description:
      "Instance-level settings (per-agent autoModeOnLaunch/model/effort, codingAgent, devCostLimitUsd, workflowContractLanguage).",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.settings.get(),
  },
  "settings/update": {
    description:
      "Update instance-level settings. autoModeOnLaunch/model/effort require agent; workflowContractLanguage is DB-backed.",
    params: params({
      agent: { enum: ["claude-code", "codex", "grok"] },
      autoModeOnLaunch: { type: "boolean" },
      model: strNonEmpty,
      effort: strNonEmpty,
      codingAgent: { enum: ["claude-code", "codex", "grok"] },
      devCostLimitUsd,
      workflowContractLanguage: { enum: ["en", "ja"] },
      session_id: sid,
    }),
    result: anyObject,
    handler: (p) =>
      svc.settings.update(
        {
          agent: p.agent,
          autoModeOnLaunch: p.autoModeOnLaunch,
          model: p.model,
          effort: p.effort,
          codingAgent: p.codingAgent,
          devCostLimitUsd: p.devCostLimitUsd,
          workflowContractLanguage: p.workflowContractLanguage,
        },
        p.session_id,
      ),
  },

  // ---- notifications ----
  "notifications/list": {
    description: "List notification-stack alerts, independent from lh inbox.",
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
      "Get the fixed system prompts used to launch the Execute/Verify steps.",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.workflows.contracts(),
  },
  "workflows/list": {
    description:
      "List global workflow definitions (Execute/Verify prompt bundles).",
    params: EMPTY_PARAMS,
    result: anyArray,
    handler: () => svc.workflows.list(),
  },
  "workflows/create": {
    description: "Create a global workflow definition.",
    params: params({ name: strNonEmpty, ...workflowFields, session_id: sid }, [
      "name",
    ]),
    result: anyObject,
    handler: (p) =>
      svc.workflows.create(
        {
          name: p.name,
          description: p.description,
          execute_prompt: p.execute_prompt,
          verify_prompt: p.verify_prompt,
        },
        p.session_id,
      ),
  },
  "workflows/update": {
    description: "Update a global workflow definition.",
    params: params(
      {
        name: strNonEmpty,
        new_name: strNonEmpty,
        ...workflowFields,
        session_id: sid,
      },
      ["name"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.workflows.update(
        p.name,
        {
          name: p.new_name,
          description: p.description,
          execute_prompt: p.execute_prompt,
          verify_prompt: p.verify_prompt,
        },
        p.session_id,
      ),
  },
  "workflows/delete": {
    description:
      "Delete a global workflow definition unless a running run references it.",
    params: params({ name: strNonEmpty, session_id: sid }, ["name"]),
    result: anyObject,
    handler: (p) => svc.workflows.delete(p.name, p.session_id),
  },
  "workflowRuns/stateForIssue": {
    description:
      "Display state of the latest Workflow run linked to an issue (status / current_step / rework_count / workflow), or null when none. Reads the run row only (#1008).",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.workflowRuns.stateForIssue(p.repo, { issue: p.number }),
  },
  "workflowRuns/stateForPull": {
    description:
      "Display state of the latest Workflow run linked to a PR (status / current_step / rework_count / workflow), or null when none. Reads the run row only (#1008).",
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
            "scheduled-task-create",
            "resume",
            "github-pr-export",
            "pr-crit",
            "workflow-run",
          ],
        },
        issueNumber: positiveInt,
        prNumber: positiveInt,
        // Saved workflow id for the "workflow-run" launch (#1007) — passed to
        // `lh workflow start ... --workflow-id <id>`. Required only for that workflow.
        workflowId: positiveInt,
        session: str,
        cwd: str,
        targetBranch: str,
        prompt: str,
        // One-shot New issue overrides (#1275/#1534): force the runtime / model / effort
        // for this launch only, without changing persisted settings.
        agent: { enum: ["claude-code", "codex", "grok"] },
        model: str,
        effort: str,
      },
      ["repo"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.terminal.launch({
        repo: p.repo,
        label: p.label,
        workflow: p.workflow,
        issueNumber: p.issueNumber,
        prNumber: p.prNumber,
        workflowId: p.workflowId,
        session: p.session,
        cwd: p.cwd,
        targetBranch: p.targetBranch,
        prompt: p.prompt,
        agent: p.agent,
        model: p.model,
        effort: p.effort,
      }),
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

  // ---- inbox ----
  "inbox/list": {
    description:
      "List Inbox messages across repositories, unread first by default.",
    params: params({ state: inboxMessageState, limit: positiveInt }),
    result: anyArray,
    handler: (p) => svc.inbox.listAll({ state: p.state, limit: p.limit }),
  },
  "inbox/get": {
    description: "Get one Inbox message by id.",
    params: params({ id: positiveInt }, ["id"]),
    result: anyObject,
    handler: (p) => svc.inbox.get(p.id),
  },
  "inbox/read": {
    description: "Mark one Inbox message as read.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.inbox.read(p.id, p.session_id),
  },
  "inbox/unread": {
    description: "Mark one Inbox message as unread.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.inbox.unread(p.id, p.session_id),
  },
  "inbox/archive": {
    description: "Archive one Inbox message.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.inbox.archive(p.id, p.session_id),
  },
  "inbox/unarchive": {
    description:
      "Move one archived Inbox message back to the active Inbox as read.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.inbox.unarchive(p.id, p.session_id),
  },
  "inbox/delete": {
    description:
      "Soft-delete one Inbox message by moving it to the deleted state.",
    params: params({ id: positiveInt, session_id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.inbox.delete(p.id, p.session_id),
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
  "issues/create": {
    description: "Open a new issue.",
    params: params(
      {
        repo,
        title: strNonEmpty,
        body: str,
        labels: stringArray,
        target_branch: strOrNull,
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
    handler: (p) => svc.comments.list(p.repo, p.number),
  },
  "comments/create": {
    description: "Add a comment to an issue.",
    params: params(
      { repo, number: positiveInt, body: strNonEmpty, session_id: sid },
      ["repo", "number", "body"],
    ),
    result: anyObject,
    handler: (p) => svc.comments.create(p.repo, p.number, p.body, p.session_id),
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

  // ---- scheduled tasks (#880) ----
  "scheduledTasks/list": {
    description: "List a repository's scheduled tasks.",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.scheduledTasks.list(p.repo),
  },
  "scheduledTasks/get": {
    description: "Get one scheduled task by id, with its recent run log.",
    params: params({ repo, id: positiveInt }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.scheduledTasks.get(p.repo, p.id),
  },
  "scheduledTasks/create": {
    description:
      "Create a scheduled task (title, prompt, agent, times, optional model/effort).",
    params: params(
      {
        repo,
        title: strNonEmpty,
        prompt: strNonEmpty,
        agent: scheduledAgent,
        times: stringArray,
        model: strOrNull,
        effort: strOrNull,
        session_id: sid,
      },
      ["repo", "title", "prompt", "agent", "times"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.scheduledTasks.create(
        p.repo,
        {
          title: p.title,
          prompt: p.prompt,
          agent: p.agent,
          times: p.times,
          model: p.model,
          effort: p.effort,
        },
        p.session_id,
      ),
  },
  "scheduledTasks/update": {
    description:
      "Update a scheduled task's fields (only provided fields change).",
    params: params(
      {
        repo,
        id: positiveInt,
        title: strNonEmpty,
        prompt: strNonEmpty,
        agent: scheduledAgent,
        times: stringArray,
        model: strOrNull,
        effort: strOrNull,
        session_id: sid,
      },
      ["repo", "id"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.scheduledTasks.update(
        p.repo,
        p.id,
        {
          title: p.title,
          prompt: p.prompt,
          agent: p.agent,
          times: p.times,
          model: p.model,
          effort: p.effort,
        },
        p.session_id,
      ),
  },
  "scheduledTasks/delete": {
    description: "Delete a scheduled task and its run log.",
    params: params({ repo, id: positiveInt, session_id: sid }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.scheduledTasks.delete(p.repo, p.id, p.session_id),
  },
  "scheduledTasks/run": {
    description:
      "Run a scheduled task immediately (Run now), without waiting for a registered time.",
    params: params({ repo, id: positiveInt, session_id: sid }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.scheduledTasks.run(p.repo, p.id),
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
  "pulls/delete": {
    description: "Delete a pull request and its PR-scoped metadata.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.delete(p.repo, p.number, p.session_id),
  },
  "pulls/files": {
    description: "List a pull request's changed files (diff).",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.pulls.files(p.repo, p.number),
  },
  "pulls/commitFiles": {
    description:
      "List files changed by one commit in a pull request, compared with its first parent.",
    params: params({ repo, number: positiveInt, sha: strNonEmpty }, [
      "repo",
      "number",
      "sha",
    ]),
    result: anyArray,
    handler: (p) => svc.pulls.commitFiles(p.repo, p.number, p.sha),
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
  "pulls/createGithubPull": {
    description:
      "External agent/skill surface (not used by the SPA). Submit a loophub PR to GitHub as a Draft PR (#411): push the head branch under `branch`, open (or recover) a Draft PR, and record it. Atomic — a retry recovers a created-but-unrecorded PR instead of duplicating. Same core orchestration as `lh pr create-github-pr` / skill `lh-create-github-pr`.",
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
      "Push the loophub PR's current head to the branch of its already-recorded GitHub PR (#848), so commits added locally after the export reach GitHub without re-creating the PR. Records the pushed head SHA.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.pushGithubPull(p.repo, p.number, p.session_id),
  },
  "pulls/githubStatus": {
    description:
      "GitHub-side status (draft / review / checks / comment counts / merged) of a PR's linked GitHub PR (#850). Fetched on demand via `gh` and cached; 404 when the PR has no linked GitHub PR.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyObject,
    handler: (p) => svc.pulls.githubStatus(p.repo, p.number),
  },
  "pulls/readyForReview": {
    description:
      "Mark a pull request ready for re-review after addressing changes.",
    params: params({ repo, number: positiveInt, body: str, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) =>
      svc.pulls.readyForReview(p.repo, p.number, p.body, p.session_id),
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
