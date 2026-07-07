// The JSON-RPC contract: every method's params JSON Schema, a descriptive result
// schema, and the handler that maps to a core/service procedure. This is the single
// language-neutral surface — clients (S4) are written against these schemas and never
// import core types. The dispatcher (rpc.ts) compiles the params schemas with ajv and
// validates incoming params before calling the handler.
import * as svc from "../../core/service.ts";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "loophub", version: "0.0.0" } as const;

// ---- reusable schema fragments ----
const str = { type: "string" } as const;
const strNonEmpty = { type: "string", minLength: 1 } as const;
const sid = { type: "string", minLength: 1 } as const;
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
    params: params({ path: strNonEmpty, name: strNonEmpty }, ["path", "name"]),
    result: anyObject,
    handler: (p) => svc.repos.create({ path: p.path, name: p.name }),
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
  "repos/remove": {
    description: "Remove a repository and its issues/PRs.",
    params: params({ name: repo }, ["name"]),
    result: { type: "null" },
    handler: (p) => svc.repos.remove(p.name) ?? null,
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

  // ---- global settings ----
  "settings/get": {
    description:
      "Instance-level config.json settings (per-agent autoModeOnBuild/model/effort, codingAgent) (#474, #499, #516, #593, #594, #682).",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.settings.get(),
  },
  "settings/update": {
    description:
      "Update instance-level config.json settings, preserving unrelated fields. autoModeOnBuild/model/effort require agent (#474, #593, #594, #682).",
    params: params({
      agent: { enum: ["claude-code", "codex"] },
      autoModeOnBuild: { type: "boolean" },
      model: strNonEmpty,
      effort: strNonEmpty,
      codingAgent: { enum: ["claude-code", "codex"] },
      session_id: sid,
    }),
    result: anyObject,
    handler: (p) =>
      svc.settings.update(
        {
          agent: p.agent,
          autoModeOnBuild: p.autoModeOnBuild,
          model: p.model,
          effort: p.effort,
          codingAgent: p.codingAgent,
        },
        p.session_id,
      ),
  },

  // ---- terminal launch ----
  "terminal/config": {
    description:
      "Terminal launch backend, always herdr — terminal workflows launch as external Herdr sessions (#562).",
    params: EMPTY_PARAMS,
    result: anyObject,
    handler: () => svc.terminal.config(),
  },
  "terminal/launch": {
    description:
      "Launch a terminal workflow as a named Herdr session. issue-dev (Build) spawns `lh build --herdr` and lets it provision the worktree/PR and the herdr pane itself (#584); the other workflows are orchestrated by this RPC directly.",
    params: params(
      {
        repo,
        label: str,
        workflow: {
          enum: ["issue-dev", "issue-create", "resume", "github-pr-export"],
        },
        issueNumber: positiveInt,
        prNumber: positiveInt,
        session: str,
        cwd: str,
        // One-shot issue-dev (Build) overrides from the issue-detail dropdown (#637): force the
        // runtime / session model for this launch only, without changing the persisted settings.
        agent: { enum: ["claude-code", "codex"] },
        model: str,
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
        session: p.session,
        cwd: p.cwd,
        agent: p.agent,
        model: p.model,
      }),
  },

  "terminal/sessions": {
    description:
      "Running herdr sessions grouped by repository, with each agent's name and status (#495), plus which running agents are pinned to a PR's worktree (pull_workspaces, #579 — drives the issue-list Herdr badge). Empty when herdr is not installed or nothing is running.",
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

  // ---- agent sessions ----
  "sessions/register": {
    description: "Register (or update) an agent session.",
    params: params(
      {
        id: sid,
        agent: strNonEmpty,
        session: strNonEmpty,
        name: str,
        runtime: str,
        kind: str,
      },
      ["id", "agent", "session"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.sessions.register({
        id: p.id,
        agent: p.agent,
        session: p.session,
        name: p.name,
        runtime: p.runtime,
        kind: p.kind,
      }),
  },
  "sessions/link": {
    description:
      "Link a registered session to an issue or a PR (exactly one of issue/pr). Generalized attach point for session kinds beyond dev; idempotent.",
    params: params(
      { repo, sessionId: sid, issue: positiveInt, pr: positiveInt },
      ["repo", "sessionId"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.sessions.link(p.repo, {
        sessionId: p.sessionId,
        issue: p.issue,
        pr: p.pr,
      }),
  },
  "sessions/listFor": {
    description:
      "Related sessions for an issue or a PR (exactly one of issue/pr), newest first, with per-row resume verdicts.",
    params: params({ repo, issue: positiveInt, pr: positiveInt }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.sessions.listFor(p.repo, { issue: p.issue, pr: p.pr }),
  },
  "sessions/list": {
    description: "List agent sessions.",
    params: EMPTY_PARAMS,
    result: anyArray,
    handler: () => svc.sessions.list(),
  },
  "sessions/get": {
    description: "Get one agent session by id.",
    params: params({ id: sid }, ["id"]),
    result: anyObject,
    handler: (p) => svc.sessions.get(p.id),
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
        page: p.page,
        perPage: p.perPage,
        sort: p.sort,
      }),
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
        session_id: sid,
      },
      ["repo", "title"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issues.create(
        p.repo,
        { title: p.title, body: p.body, labels: p.labels },
        p.session_id,
      ),
  },
  "issues/update": {
    description: "Edit an issue's title/body/state/labels.",
    params: params(
      {
        repo,
        number: positiveInt,
        title: str,
        body: str,
        state: { enum: ["open", "closed"] },
        labels: stringArray,
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issues.update(
        p.repo,
        p.number,
        { title: p.title, body: p.body, state: p.state, labels: p.labels },
        p.session_id,
      ),
  },
  "issues/addLabels": {
    description: "Add labels to an issue.",
    params: params(
      { repo, number: positiveInt, labels: stringArray, session_id: sid },
      ["repo", "number", "labels"],
    ),
    result: anyArray,
    handler: (p) =>
      svc.issues.addLabels(p.repo, p.number, p.labels, p.session_id),
  },
  "issues/removeLabel": {
    description: "Remove a label from an issue.",
    params: params(
      { repo, number: positiveInt, label: strNonEmpty, session_id: sid },
      ["repo", "number", "label"],
    ),
    result: { type: "null" },
    handler: (p) =>
      svc.issues.removeLabel(p.repo, p.number, p.label, p.session_id) ?? null,
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
  "handoffs/record": {
    description:
      "Record a handoff: a parent's instruction (dir=down) or a child's return (dir=up). Binds to a PR and/or issue (one required) plus the recording session. Pass body for inline content (instruction/Verify report), or src+hash to reference a canonical copy (plan=PR, diff=commit) without duplicating it.",
    params: params(
      {
        repo,
        phase: strNonEmpty,
        dir: { enum: ["down", "up"] },
        pr: positiveInt,
        issue: positiveInt,
        from: str,
        to: str,
        body: str,
        src: str,
        hash: str,
        summary: str,
        model: str,
        cost: str,
        session_id: sid,
      },
      ["repo", "phase", "dir"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.handoffs.record(
        p.repo,
        {
          phase: p.phase,
          direction: p.dir,
          pr: p.pr,
          issue: p.issue,
          from: p.from,
          to: p.to,
          body: p.body,
          src: p.src,
          hash: p.hash,
          summary: p.summary,
          model: p.model,
          cost: p.cost,
        },
        p.session_id,
      ),
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
  "pulls/create": {
    description: "Open a pull request.",
    params: params(
      {
        repo,
        title: strNonEmpty,
        body: str,
        head: strNonEmpty,
        base: strNonEmpty,
        issue: positiveInt,
        draft: { type: "boolean" },
        session_id: sid,
      },
      ["repo", "title", "head", "base"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.create(
        p.repo,
        {
          title: p.title,
          body: p.body,
          head: p.head,
          base: p.base,
          issue: p.issue,
          draft: p.draft,
        },
        p.session_id,
      ),
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
  "pulls/files": {
    description: "List a pull request's changed files (diff).",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.pulls.files(p.repo, p.number),
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
  "pulls/recordGithubPull": {
    description:
      "Record the GitHub PR a loophub PR was exported to (#406). Idempotent on the PR.",
    params: params(
      {
        repo,
        number: positiveInt,
        github_number: positiveInt,
        url: strNonEmpty,
        branch: str,
        session_id: sid,
      },
      ["repo", "number", "github_number", "url"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.pulls.recordGithubPull(
        p.repo,
        p.number,
        { github_number: p.github_number, url: p.url, branch: p.branch },
        p.session_id,
      ),
  },
  "pulls/createGithubPull": {
    description:
      "Submit a loophub PR to GitHub as a Draft PR (#411): push the head branch under `branch`, open (or recover) a Draft PR, and record it. Atomic — a retry recovers a created-but-unrecorded PR instead of duplicating.",
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
  "pulls/markGithubMerged": {
    description:
      "Close a GitHub-linked PR (and its linked issue) as merged, without a local git merge, once lh-worker's polling has detected the GitHub PR as merged.",
    params: params({ repo, number: positiveInt, session_id: sid }, [
      "repo",
      "number",
    ]),
    result: anyObject,
    handler: (p) => svc.pulls.markGithubMerged(p.repo, p.number, p.session_id),
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
  "reviews/create": {
    description: "Submit a review (optionally with line comments).",
    params: params(
      {
        repo,
        number: positiveInt,
        event: {
          enum: [
            "COMMENT",
            "PASS",
            "REQUEST_CHANGES",
            "comment",
            "pass",
            "request_changes",
            // Back-compat (#428): "approve" was the vocabulary before the
            // pass/fail rename; core/service.ts normalizes it to PASS.
            "APPROVE",
            "approve",
          ],
        },
        body: str,
        topic: str,
        comments: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: strNonEmpty,
              line: positiveInt,
              side: str,
              body: strNonEmpty,
            },
            required: ["path", "body"],
            additionalProperties: false,
          },
        },
        session_id: sid,
      },
      ["repo", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.reviews.create(
        p.repo,
        p.number,
        { event: p.event, body: p.body, topic: p.topic, comments: p.comments },
        p.session_id,
      ),
  },

  // ---- events ----
  "events/list": {
    description: "Poll events (webhook-style) by id cursor.",
    params: params({
      since: { type: "integer", minimum: 0 },
      repo,
      labels: stringArray,
      order: { enum: ["asc", "desc"] },
      limit: positiveInt,
    }),
    result: anyArray,
    handler: (p) =>
      svc.events.list({
        since: p.since,
        repo: p.repo,
        labels: p.labels,
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
      "Sweep open-PR heads and emit pull_request.updated when a head moved.",
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
      notifications: ["events/notify"],
    },
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
    notifications: [
      {
        method: "events/notify",
        description: "A LoopEvent delivered to a subscriber.",
        params: anyObject,
      },
    ],
  };
}
