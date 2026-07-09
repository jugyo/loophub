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
  PevrExecutionReportArtifact,
  PevrPlanArtifact,
  PevrReflectionArtifact,
  PevrVerdictArtifact,
} from "./artifacts.ts";
import { PEVR_STEPS, type PevrInputFileRef, type PevrStep } from "./compose.ts";

export type PevrInputArtifactFile = {
  name: string;
  description: string;
  content: string;
};

export type PevrStepInputSet = {
  step: PevrStep;
  files: PevrInputArtifactFile[];
};

export type PevrIssueInput = {
  title: string;
  body: string;
  comments?: PevrIssueCommentInput[];
};

export type PevrIssueCommentInput = {
  author: string;
  createdAt: string;
  body: string;
};

export type PevrPlanInput = {
  issue: PevrIssueInput;
};

export type PevrExecuteInput = {
  issue: PevrIssueInput;
  plan: PevrPlanArtifact;
  latestVerdict?: PevrVerdictArtifact;
  verdictHeadSha?: string;
  note?: string;
};

export type PevrVerifyInput = {
  issue: PevrIssueInput;
  headSha: string;
  baseBranch: string;
  diff: string;
  report: PevrExecutionReportArtifact;
  priorVerdicts?: PevrVerdictArtifact[];
};

export type PevrReflectInput = {
  issue: PevrIssueInput;
  artifacts: PevrRunArtifactInput[];
  reworkCount: number;
  timeline: PevrTimelineEntryInput[];
  handoffs?: string[];
};

export type PevrRunArtifactInput =
  | PevrPlanArtifact
  | PevrExecutionReportArtifact
  | PevrVerdictArtifact
  | PevrReflectionArtifact;

export type PevrTimelineEntryInput = {
  at: string;
  step: PevrStep | "parent";
  text: string;
};

export function composePlanInputArtifacts(
  input: PevrPlanInput,
): PevrStepInputSet {
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
  input: PevrExecuteInput,
): PevrStepInputSet {
  const files: PevrInputArtifactFile[] = [
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
  input: PevrVerifyInput,
): PevrStepInputSet {
  const files: PevrInputArtifactFile[] = [
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
  input: PevrReflectInput,
): PevrStepInputSet {
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

export function writePevrStepInputArtifacts(
  rootDir: string,
  inputSet: PevrStepInputSet,
): PevrInputFileRef[] {
  const root = resolve(rootDir);
  assertNotSymlink(root);
  mkdirSync(root, { recursive: true });
  const realRoot = realpathSync(root);

  const stepDir = resolve(root, safePevrStep(inputSet.step));
  assertNotSymlink(stepDir);
  mkdirSync(stepDir, { recursive: true });

  const inputDir = resolve(stepDir, "input");
  assertNotSymlink(inputDir);
  mkdirSync(inputDir, { recursive: true });
  const realInputDir = realpathSync(inputDir);
  if (!isPathInsideOrEqual(realRoot, realInputDir)) {
    throw new Error(
      `PEVR input directory escapes run directory: ${inputSet.step}`,
    );
  }

  return inputSet.files.map((file) => {
    const path = resolve(realInputDir, safeInputArtifactName(file.name));
    if (!isPathInside(realInputDir, path)) {
      throw new Error(
        `PEVR input artifact path escapes input directory: ${file.name}`,
      );
    }
    writeFileNoFollow(path, file.content);
    return { path, description: file.description };
  });
}

function safePevrStep(step: PevrStep): PevrStep {
  if (!PEVR_STEPS.includes(step)) {
    throw new Error(`Invalid PEVR step: ${String(step)}`);
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
    throw new Error(`Invalid PEVR input artifact name: ${name}`);
  }
  return name;
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`PEVR input path must not be a symlink: ${path}`);
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
      throw new Error(`PEVR input artifact must not be a symlink: ${path}`);
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

function renderIssueTask(issue: PevrIssueInput): string {
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

function renderPlanArtifact(plan: PevrPlanArtifact): string {
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

function renderExecutionReport(report: PevrExecutionReportArtifact): string {
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
  verdict: PevrVerdictArtifact,
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

function renderVerdict(verdict: PevrVerdictArtifact): string {
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

function renderRunDigest(input: PevrReflectInput): string {
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
