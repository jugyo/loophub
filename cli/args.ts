import { parseArgs } from "node:util";

// ---- arg parsing ----
// Declare each flag's type so boolean flags (--sandbox/--verbose/--json) never swallow the
// next token: `lh build --sandbox 123` and `lh build 123 --sandbox` parse identically, and
// `--repo=me/x` works. strict:false keeps the old lenient behavior for any undeclared flag.
export type Flags = {
  help?: boolean;
  repo?: string;
  "session-id"?: string;
  sessionId?: string;
  sandbox?: boolean;
  auto?: boolean;
  verbose?: boolean;
  herdr?: boolean;
  force?: boolean;
  "new-attempt"?: boolean;
  "claude-code"?: boolean;
  codex?: boolean;
  draft?: boolean;
  full?: boolean;
  json?: boolean;
  allow?: string;
  path?: string;
  name?: string;
  // string when a value is given (--archived all|true|false); boolean true when bare
  // (--archived), since strict:false resolves a value-less declared flag to true.
  archived?: string | boolean;
  "default-branch"?: string;
  "target-branch"?: string;
  "create-target-branch"?: boolean;
  state?: string;
  label?: string;
  title?: string;
  body?: string;
  id?: string;
  agent?: string;
  session?: string;
  runtime?: string;
  head?: string;
  base?: string;
  issue?: string;
  method?: string;
  comments?: string;
  commit?: string;
  event?: string;
  topic?: string;
  since?: string;
  order?: string;
  add?: string;
  yes?: boolean;
  "dry-run"?: boolean;
  kind?: string;
  summary?: string;
  pr?: string;
  file?: string[];
  actor?: string;
  input?: string;
  status?: string;
  limit?: string;
  phase?: string;
  dir?: string;
  src?: string;
  from?: string;
  to?: string;
  hash?: string;
  model?: string;
  cost?: string;
  number?: string;
  url?: string;
  branch?: string;
  resource?: string;
  "source-key"?: string;
  "herdr-pane-id"?: string;
  "herdr-session"?: string;
  all?: boolean;
  description?: string;
  "plan-prompt"?: string;
  "execute-prompt"?: string;
  "verify-prompt"?: string;
  "reflect-prompt"?: string;
  step?: string;
  workflow?: string;
  "workflow-id"?: string;
  "no-launch"?: boolean;
  run?: string;
  note?: string;
  "rework-count"?: string;
  "tab-id"?: string;
};
const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    help: { type: "boolean" },
    repo: { type: "string" },
    "session-id": { type: "string" },
    sessionId: { type: "string" },
    sandbox: { type: "boolean" },
    auto: { type: "boolean" },
    verbose: { type: "boolean" },
    herdr: { type: "boolean" },
    force: { type: "boolean" },
    "new-attempt": { type: "boolean" },
    "claude-code": { type: "boolean" },
    codex: { type: "boolean" },
    draft: { type: "boolean" },
    full: { type: "boolean" },
    json: { type: "boolean" },
    allow: { type: "string" },
    path: { type: "string" },
    name: { type: "string" },
    archived: { type: "string" },
    "default-branch": { type: "string" },
    "target-branch": { type: "string" },
    "create-target-branch": { type: "boolean" },
    state: { type: "string" },
    label: { type: "string" },
    title: { type: "string" },
    body: { type: "string" },
    id: { type: "string" },
    agent: { type: "string" },
    session: { type: "string" },
    runtime: { type: "string" },
    head: { type: "string" },
    base: { type: "string" },
    issue: { type: "string" },
    method: { type: "string" },
    comments: { type: "string" },
    commit: { type: "string" },
    event: { type: "string" },
    topic: { type: "string" },
    since: { type: "string" },
    order: { type: "string" },
    add: { type: "string" },
    yes: { type: "boolean" },
    "dry-run": { type: "boolean" },
    kind: { type: "string" },
    summary: { type: "string" },
    pr: { type: "string" },
    file: { type: "string", multiple: true },
    actor: { type: "string" },
    input: { type: "string" },
    status: { type: "string" },
    limit: { type: "string" },
    phase: { type: "string" },
    dir: { type: "string" },
    src: { type: "string" },
    from: { type: "string" },
    to: { type: "string" },
    hash: { type: "string" },
    model: { type: "string" },
    cost: { type: "string" },
    number: { type: "string" },
    url: { type: "string" },
    branch: { type: "string" },
    resource: { type: "string" },
    "source-key": { type: "string" },
    "herdr-pane-id": { type: "string" },
    "herdr-session": { type: "string" },
    all: { type: "boolean" },
    description: { type: "string" },
    "plan-prompt": { type: "string" },
    "execute-prompt": { type: "string" },
    "verify-prompt": { type: "string" },
    "reflect-prompt": { type: "string" },
    step: { type: "string" },
    workflow: { type: "string" },
    "workflow-id": { type: "string" },
    "no-launch": { type: "boolean" },
    run: { type: "string" },
    note: { type: "string" },
    "rework-count": { type: "string" },
    "tab-id": { type: "string" },
  },
});
export const flags = values as Flags;
export const pos = positionals;

// ---- dispatch target ----
export const [group, sub, ...rest] = pos;
