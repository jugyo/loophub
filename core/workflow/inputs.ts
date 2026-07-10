import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, relative, resolve } from "node:path";
import type {
  WorkflowExecutionReportArtifact,
  WorkflowPlanArtifact,
  WorkflowReflectionArtifact,
  WorkflowVerdictArtifact,
} from "./artifacts.ts";
import {
  WORKFLOW_STEPS,
  type WorkflowInputFileRef,
  type WorkflowStep,
} from "./compose.ts";

export type WorkflowInputArtifactFile = {
  name: string;
  description: string;
  content: string;
};

export type WorkflowStepInputSet = {
  step: WorkflowStep;
  files: WorkflowInputArtifactFile[];
};

export type WorkflowIssueInput = {
  title: string;
  body: string;
  comments?: WorkflowIssueCommentInput[];
};

export type WorkflowIssueCommentInput = {
  author: string;
  createdAt: string;
  body: string;
};

export type WorkflowPlanInput = {
  issue: WorkflowIssueInput;
};

export type WorkflowExecuteInput = {
  issue: WorkflowIssueInput;
  plan: WorkflowPlanArtifact;
  latestVerdict?: WorkflowVerdictArtifact;
  verdictHeadSha?: string;
  note?: string;
};

export type WorkflowVerifyInput = {
  issue: WorkflowIssueInput;
  headSha: string;
  baseBranch: string;
  diff: string;
  report: WorkflowExecutionReportArtifact;
  priorVerdicts?: WorkflowVerdictArtifact[];
};

export type WorkflowReflectInput = {
  issue: WorkflowIssueInput;
  artifacts: WorkflowRunArtifactInput[];
  reworkCount: number;
  timeline: WorkflowTimelineEntryInput[];
  handoffs?: string[];
};

export type WorkflowRunArtifactInput =
  | WorkflowPlanArtifact
  | WorkflowExecutionReportArtifact
  | WorkflowVerdictArtifact
  | WorkflowReflectionArtifact;

export type WorkflowTimelineEntryInput = {
  at: string;
  step: WorkflowStep | "parent";
  text: string;
};

export function composePlanInputArtifacts(
  input: WorkflowPlanInput,
): WorkflowStepInputSet {
  return {
    step: "plan",
    files: [
      {
        name: "task.md",
        description: "Requested outcome and acceptance criteria",
        content: renderIssueTask(input.issue),
      },
    ],
  };
}

export function composeExecuteInputArtifacts(
  input: WorkflowExecuteInput,
): WorkflowStepInputSet {
  const files: WorkflowInputArtifactFile[] = [
    {
      name: "task.md",
      description: "Requested outcome and acceptance criteria",
      content: renderIssueTask(input.issue),
    },
    {
      name: "plan.md",
      description: "Accepted implementation plan",
      content: renderPlanArtifact(input.plan),
    },
  ];

  if (input.latestVerdict?.event === "request_changes") {
    files.push({
      name: "findings.md",
      description: "Requested changes for the current worktree state",
      content: renderFindings(input.latestVerdict, input.verdictHeadSha),
    });
  }

  return { step: "execute", files };
}

export function composeVerifyInputArtifacts(
  input: WorkflowVerifyInput,
): WorkflowStepInputSet {
  const files: WorkflowInputArtifactFile[] = [
    {
      name: "task.md",
      description: "Requested outcome and acceptance criteria",
      content: renderIssueTask(input.issue),
    },
    {
      name: "changes.diff",
      description: `Change diff pinned to ${input.headSha}`,
      content: [
        `# Diff pinned to ${input.headSha}`,
        `Base branch: ${input.baseBranch}`,
        "",
        input.diff,
      ].join("\n"),
    },
    {
      name: "report.md",
      description: "Execution report",
      content: renderExecutionReport(input.report),
    },
  ];

  if (input.priorVerdicts && input.priorVerdicts.length > 0) {
    files.push({
      name: "prior-verdicts.md",
      description: "Earlier verdicts and findings",
      content: input.priorVerdicts.map(renderVerdict).join("\n\n---\n\n"),
    });
  }

  return { step: "verify", files };
}

export function composeReflectInputArtifacts(
  input: WorkflowReflectInput,
): WorkflowStepInputSet {
  return {
    step: "reflect",
    files: [
      {
        name: "run-digest.md",
        description: "Run history, artifacts, rework count, and timeline",
        content: renderRunDigest(input),
      },
    ],
  };
}

export function writeWorkflowStepInputArtifacts(
  rootDir: string,
  inputSet: WorkflowStepInputSet,
): WorkflowInputFileRef[] {
  const root = resolve(rootDir);
  assertNotSymlink(root);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);

  const stepDir = resolve(root, safeWorkflowStep(inputSet.step));
  assertNotSymlink(stepDir);
  mkdirSync(stepDir, { recursive: true });

  const inputDir = resolve(stepDir, "input");
  assertNotSymlink(inputDir);
  mkdirSync(inputDir, { recursive: true });
  const realInputDir = realpathSync(inputDir);
  if (!isPathInsideOrEqual(realRoot, realInputDir)) {
    throw new Error(
      `Workflow input directory escapes run directory: ${inputSet.step}`,
    );
  }

  return inputSet.files.map((file) => {
    const path = resolve(realInputDir, safeInputArtifactName(file.name));
    if (!isPathInside(realInputDir, path)) {
      throw new Error(
        `Workflow input artifact path escapes input directory: ${file.name}`,
      );
    }
    writeFileNoFollow(path, file.content);
    return { path, description: file.description };
  });
}

function safeWorkflowStep(step: WorkflowStep): WorkflowStep {
  if (!WORKFLOW_STEPS.includes(step)) {
    throw new Error(`Invalid Workflow step: ${String(step)}`);
  }
  return step;
}

function safeInputArtifactName(name: string): string {
  if (
    name.trim() === "" ||
    /[\u0000-\u001f\u007f]/u.test(name) ||
    isAbsolute(name) ||
    name !== basename(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`Invalid Workflow input artifact name: ${name}`);
  }
  return name;
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Workflow input path must not be a symlink: ${path}`);
    }
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") {
      return;
    }
    throw e;
  }
}

function writeFileNoFollow(path: string, content: string): void {
  unlinkExistingNonSymlink(path);
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
  );
  try {
    writeFileSync(fd, content);
  } finally {
    closeSync(fd);
  }
}

function unlinkExistingNonSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`Workflow input artifact must not be a symlink: ${path}`);
    }
    unlinkSync(path);
  } catch (e) {
    if (isNodeError(e) && e.code === "ENOENT") {
      return;
    }
    throw e;
  }
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  return parent === child || isPathInside(parent, child);
}

function isNodeError(e: unknown): e is NodeJS.ErrnoException {
  return e instanceof Error && "code" in e;
}

function renderIssueTask(issue: WorkflowIssueInput): string {
  const comments = issue.comments ?? [];
  const sections = [
    `# ${issue.title}`,
    "",
    "## Body",
    issue.body.trim() || "(empty)",
  ];

  if (comments.length > 0) {
    sections.push("", "## Comments");
    for (const comment of comments) {
      sections.push(
        "",
        `### ${comment.author} at ${comment.createdAt}`,
        "",
        comment.body.trim() || "(empty)",
      );
    }
  }

  return `${sections.join("\n")}\n`;
}

function renderPlanArtifact(plan: WorkflowPlanArtifact): string {
  return [
    "# Plan",
    "",
    plan.summary,
    "",
    "## Changes",
    ...plan.changes.map((change) => `- ${change.area}: ${change.description}`),
    "",
    "## Reuse",
    ...renderListOrNone(plan.reuse),
    "",
    "## Out of scope",
    ...renderListOrNone(plan.out_of_scope),
    "",
    "## Verification",
    plan.verification,
    "",
  ].join("\n");
}

function renderExecutionReport(
  report: WorkflowExecutionReportArtifact,
): string {
  return [
    "# Execution report",
    "",
    report.summary,
    "",
    "## Acceptance",
    ...report.acceptance.map(
      (item) => `- [${item.met ? "x" : " "}] ${item.criterion} - ${item.note}`,
    ),
    "",
    "## Tests",
    ...report.tests.map(
      (test) =>
        `- [${test.passed ? "x" : " "}] ${test.command} - ${test.excerpt}`,
    ),
    "",
    "## Evidence",
    ...report.evidence.map((item) =>
      item.path
        ? `- ${item.kind}: ${item.description} (${item.path})`
        : `- ${item.kind}: ${item.description}`,
    ),
    "",
  ].join("\n");
}

function renderFindings(
  verdict: WorkflowVerdictArtifact,
  headSha: string | undefined,
): string {
  return [
    "# Findings",
    "",
    headSha ? `Verdict target: ${headSha}` : "Verdict target: unknown",
    "",
    verdict.summary,
    "",
    ...verdict.findings.map((finding) => {
      const location = finding.line
        ? `${finding.file}:${finding.line}`
        : finding.file;
      return [
        `## ${location}`,
        "",
        `Problem: ${finding.problem}`,
        "",
        `Expected: ${finding.expected}`,
      ].join("\n");
    }),
    "",
  ].join("\n");
}

function renderVerdict(verdict: WorkflowVerdictArtifact): string {
  return [
    `# Verdict: ${verdict.event}`,
    "",
    verdict.summary,
    "",
    "## Findings",
    ...renderListOrNone(
      verdict.findings.map((finding) => {
        const location = finding.line
          ? `${finding.file}:${finding.line}`
          : finding.file;
        return `${location} - ${finding.problem} Expected: ${finding.expected}`;
      }),
    ),
  ].join("\n");
}

function renderRunDigest(input: WorkflowReflectInput): string {
  return [
    "# Run digest",
    "",
    "## Task",
    renderIssueTask(input.issue).trimEnd(),
    "",
    `Rework count: ${input.reworkCount}`,
    "",
    "## Timeline",
    ...input.timeline.map(
      (entry) => `- ${entry.at} ${entry.step}: ${entry.text}`,
    ),
    "",
    "## Artifacts",
    ...input.artifacts.map((artifact) => {
      return [
        `### ${artifact.type}`,
        "",
        JSON.stringify(artifact, null, 2),
      ].join("\n");
    }),
    "",
    "## Handoffs",
    ...renderListOrNone(input.handoffs ?? []),
    "",
  ].join("\n");
}

function renderListOrNone(values: string[]): string[] {
  return values.length > 0 ? values.map((value) => `- ${value}`) : ["- (none)"];
}
