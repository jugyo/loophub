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

  // ---- review notes (#204, PR-independent since #216) ----
  "reviewNotes/list": {
    description:
      "List a repo's review notes (per-file diff descriptions), newest first. All filters optional: pr narrows to one PR, path to one file, base_sha/commit_sha to one diff range.",
    params: params(
      {
        repo,
        pr: positiveInt,
        path: str,
        base_sha: str,
        commit_sha: str,
      },
      ["repo"],
    ),
    result: anyArray,
    handler: (p) =>
      svc.reviewNotes.list(p.repo, {
        pr: p.pr,
        path: p.path,
        baseSha: p.base_sha,
        commitSha: p.commit_sha,
      }),
  },
  "reviewNotes/get": {
    description: "Get a single review note by id.",
    params: params({ repo, id: positiveInt }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.reviewNotes.get(p.repo, p.id),
  },
  "reviewNotes/create": {
    description:
      "Create a review note for a file on a commit range. PR-independent: pass base_sha + commit_sha. Or pass pr to associate the note with a PR and default the range to its base..head.",
    params: params(
      {
        repo,
        path: strNonEmpty,
        body: strNonEmpty,
        base_sha: str,
        commit_sha: str,
        pr: positiveInt,
        session_id: sid,
      },
      ["repo", "path", "body"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.reviewNotes.create(
        p.repo,
        {
          path: p.path,
          body: p.body,
          baseSha: p.base_sha,
          commitSha: p.commit_sha,
          pr: p.pr,
        },
        p.session_id,
      ),
  },
  "reviewNotes/update": {
    description: "Edit a review note's body.",
    params: params(
      { repo, id: positiveInt, body: strNonEmpty, session_id: sid },
      ["repo", "id", "body"],
    ),
    result: anyObject,
    handler: (p) => svc.reviewNotes.update(p.repo, p.id, p.body, p.session_id),
  },
  "reviewNotes/delete": {
    description: "Delete a review note.",
    params: params({ repo, id: positiveInt, session_id: sid }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.reviewNotes.remove(p.repo, p.id, p.session_id),
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

  // ---- issue groups (#312) ----
  "issueGroups/list": {
    description: "List a repository's issue groups (each with a member count).",
    params: params({ repo }, ["repo"]),
    result: anyArray,
    handler: (p) => svc.issueGroups.list(p.repo),
  },
  "issueGroups/get": {
    description: "Get one issue group by id.",
    params: params({ repo, id: positiveInt }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.issueGroups.get(p.repo, p.id),
  },
  "issueGroups/members": {
    description: "List a group's issues, ordered by position.",
    params: params({ repo, id: positiveInt }, ["repo", "id"]),
    result: anyArray,
    handler: (p) => svc.issueGroups.members(p.repo, p.id),
  },
  "issueGroups/forIssue": {
    description:
      "List the groups an issue (by number) belongs to, each with its ordered members.",
    params: params({ repo, number: positiveInt }, ["repo", "number"]),
    result: anyArray,
    handler: (p) => svc.issueGroups.forIssue(p.repo, p.number),
  },
  "issueGroups/create": {
    description: "Create an issue group.",
    params: params({ repo, name: strNonEmpty, session_id: sid }, [
      "repo",
      "name",
    ]),
    result: anyObject,
    handler: (p) => svc.issueGroups.create(p.repo, p.name, p.session_id),
  },
  "issueGroups/rename": {
    description: "Rename an issue group.",
    params: params(
      { repo, id: positiveInt, name: strNonEmpty, session_id: sid },
      ["repo", "id", "name"],
    ),
    result: anyObject,
    handler: (p) => svc.issueGroups.rename(p.repo, p.id, p.name, p.session_id),
  },
  "issueGroups/delete": {
    description:
      "Delete an issue group (memberships are removed; issues are untouched).",
    params: params({ repo, id: positiveInt, session_id: sid }, ["repo", "id"]),
    result: anyObject,
    handler: (p) => svc.issueGroups.remove(p.repo, p.id, p.session_id),
  },
  "issueGroups/addIssue": {
    description:
      "Add an issue (by number) to a group, appended to the group's order. Idempotent.",
    params: params(
      { repo, id: positiveInt, number: positiveInt, session_id: sid },
      ["repo", "id", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issueGroups.addIssue(p.repo, p.id, p.number, p.session_id),
  },
  "issueGroups/removeIssue": {
    description: "Remove an issue (by number) from a group.",
    params: params(
      { repo, id: positiveInt, number: positiveInt, session_id: sid },
      ["repo", "id", "number"],
    ),
    result: anyObject,
    handler: (p) =>
      svc.issueGroups.removeIssue(p.repo, p.id, p.number, p.session_id),
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
      "Read-only debug dump for a PR: raw DB rows (issue/pull/linked issue/labels), git facts (refs, SHAs, diffstat, commits, files), reviews, comments, review notes, related events, and the dev session.",
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
