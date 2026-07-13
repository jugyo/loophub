import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  composeExecuteInputArtifacts,
  composeVerifyInputArtifacts,
  writeWorkflowStepInputArtifacts,
} from "./inputs.ts";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composes Execute input from task text and comments without filesystem writes", () => {
  const result = composeExecuteInputArtifacts({
    issue: {
      title: "Add Workflow composition",
      body: "Acceptance criteria\n- prompts stay separated",
      comments: [
        {
          author: "reviewer",
          createdAt: "2026-07-09T00:00:00Z",
          body: "Later design note",
        },
      ],
    },
  });

  expect(result).toEqual({
    step: "execute",
    files: [
      expect.objectContaining({
        name: "task.md",
        description: "Requested outcome and acceptance criteria",
      }),
    ],
  });
  expect(result.files[0]?.content).toContain("Add Workflow composition");
  expect(result.files[0]?.content).toContain("Later design note");
});

test("composes Execute inputs with optional findings", () => {
  const result = composeExecuteInputArtifacts({
    issue: { title: "Task", body: "Body" },
    latestVerdict: {
      type: "verdict",
      event: "request_changes",
      summary: "Fix one issue",
      findings: [
        {
          file: "core/workflow/compose.ts",
          line: 12,
          problem: "Prompt channels are mixed",
          expected: "Keep channels separate",
        },
      ],
    },
    verdictHeadSha: "abc123",
  });

  expect(result.step).toBe("execute");
  expect(result.files.map((file) => file.name)).toEqual([
    "task.md",
    "findings.md",
  ]);
  expect(
    result.files.find((file) => file.name === "findings.md")?.content,
  ).toContain("abc123");
});

test("composes Verify inputs with pinned diff and prior verdicts", () => {
  const result = composeVerifyInputArtifacts({
    issue: { title: "Task", body: "Body" },
    headSha: "def456",
    baseBranch: "main",
    diff: "diff --git a/a.ts b/a.ts",
    report: {
      type: "execution-report",
      summary: "Implemented.",
      acceptance: [{ criterion: "Works", met: true, note: "Done" }],
      tests: [{ command: "npm test", passed: true, excerpt: "1 passed" }],
      evidence: [{ kind: "test", description: "Focused test passed" }],
      reflection: {
        went_well: ["Focused change"],
        friction: [],
        suggestions: [],
        followups: [],
      },
    },
    priorVerdicts: [
      {
        type: "verdict",
        event: "pass",
        summary: "Looks good",
        findings: [],
      },
    ],
  });

  expect(result.step).toBe("verify");
  expect(result.files.map((file) => file.name)).toEqual([
    "task.md",
    "changes.diff",
    "report.md",
    "prior-verdicts.md",
  ]);
  expect(
    result.files.find((file) => file.name === "changes.diff")?.content,
  ).toContain("def456");
});

test("writes input artifacts under the run directory and returns path references", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  tmpRoots.push(root);
  const refs = writeWorkflowStepInputArtifacts(root, {
    step: "execute",
    files: [
      {
        name: "task.md",
        description: "Requested outcome and acceptance criteria",
        content: "# Task\n",
      },
    ],
  });

  expect(refs).toEqual([
    {
      path: join(realpathSync(root), "execute", "input", "task.md"),
      description: "Requested outcome and acceptance criteria",
    },
  ]);
  expect(existsSync(refs[0].path)).toBe(true);
  expect(readFileSync(refs[0].path, "utf8")).toBe("# Task\n");
});

test("rejects input artifact names that can escape the input directory", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  tmpRoots.push(root);

  for (const name of [
    "../escape.md",
    "nested/task.md",
    "/tmp/task.md",
    "..",
    "",
  ]) {
    expect(() =>
      writeWorkflowStepInputArtifacts(root, {
        step: "execute",
        files: [
          {
            name,
            description: "Bad path",
            content: "bad",
          },
        ],
      }),
    ).toThrow(/Workflow input artifact name/u);
  }
});

test("rejects step names that can escape the run directory at runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  tmpRoots.push(root);

  expect(() =>
    writeWorkflowStepInputArtifacts(root, {
      step: "../../outside" as "execute",
      files: [
        {
          name: "task.md",
          description: "Task",
          content: "bad",
        },
      ],
    }),
  ).toThrow(/Invalid Workflow step/u);
});

test("rejects symlinked input directories before writing artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  const outside = mkdtempSync(join(tmpdir(), "workflow-outside-"));
  tmpRoots.push(root, outside);
  mkdirSync(join(root, "execute"), { recursive: true });
  symlinkSync(outside, join(root, "execute", "input"), "dir");

  expect(() =>
    writeWorkflowStepInputArtifacts(root, {
      step: "execute",
      files: [
        {
          name: "task.md",
          description: "Task",
          content: "bad",
        },
      ],
    }),
  ).toThrow(/symlink/u);
  expect(existsSync(join(outside, "task.md"))).toBe(false);
});

test("rejects symlinked artifact files before overwriting outside targets", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  const outside = mkdtempSync(join(tmpdir(), "workflow-outside-"));
  tmpRoots.push(root, outside);
  mkdirSync(join(root, "execute", "input"), { recursive: true });
  const outsideFile = join(outside, "task.md");
  symlinkSync(outsideFile, join(root, "execute", "input", "task.md"));

  expect(() =>
    writeWorkflowStepInputArtifacts(root, {
      step: "execute",
      files: [
        {
          name: "task.md",
          description: "Task",
          content: "bad",
        },
      ],
    }),
  ).toThrow();
  expect(existsSync(outsideFile)).toBe(false);
});

test("replaces hard-linked artifact files without truncating outside targets", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-inputs-"));
  const outside = mkdtempSync(join(tmpdir(), "workflow-outside-"));
  tmpRoots.push(root, outside);
  mkdirSync(join(root, "execute", "input"), { recursive: true });
  const outsideFile = join(outside, "task.md");
  const artifactPath = join(root, "execute", "input", "task.md");
  writeFileSync(outsideFile, "outside\n");
  linkSync(outsideFile, artifactPath);

  const refs = writeWorkflowStepInputArtifacts(root, {
    step: "execute",
    files: [
      {
        name: "task.md",
        description: "Task",
        content: "inside\n",
      },
    ],
  });

  expect(refs[0].path).toBe(
    join(realpathSync(root), "execute", "input", "task.md"),
  );
  expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  expect(readFileSync(artifactPath, "utf8")).toBe("inside\n");
});
