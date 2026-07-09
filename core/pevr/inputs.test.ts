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
  composePlanInputArtifacts,
  composeReflectInputArtifacts,
  composeVerifyInputArtifacts,
  writePevrStepInputArtifacts,
} from "./inputs.ts";

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("composes Plan input from task text and comments without filesystem writes", () => {
  const result = composePlanInputArtifacts({
    issue: {
      title: "Add PEVR composition",
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
    step: "plan",
    files: [
      expect.objectContaining({
        name: "task.md",
        description: "Requested outcome and acceptance criteria",
      }),
    ],
  });
  expect(result.files[0]?.content).toContain("Add PEVR composition");
  expect(result.files[0]?.content).toContain("Later design note");
});

test("composes Execute inputs with plan and optional findings", () => {
  const result = composeExecuteInputArtifacts({
    issue: { title: "Task", body: "Body" },
    plan: {
      type: "plan",
      summary: "Plan summary",
      changes: [{ area: "core/pevr", description: "Add composition" }],
      reuse: ["artifacts.ts types"],
      out_of_scope: ["CLI launch"],
      verification: "Run vitest",
    },
    latestVerdict: {
      type: "verdict",
      event: "request_changes",
      summary: "Fix one issue",
      findings: [
        {
          file: "core/pevr/compose.ts",
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
    "plan.md",
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

test("composes Reflect digest from artifacts and timeline", () => {
  const result = composeReflectInputArtifacts({
    issue: {
      title: "Original task",
      body: "Acceptance criteria\n- include the request",
    },
    artifacts: [
      {
        type: "reflection",
        went_well: ["Small modules"],
        friction: [],
        suggestions: [],
        followups: [],
      },
    ],
    reworkCount: 1,
    timeline: [{ at: "2026-07-09T00:00:00Z", step: "verify", text: "pass" }],
    handoffs: ["No handoff"],
  });

  expect(result).toEqual({
    step: "reflect",
    files: [expect.objectContaining({ name: "run-digest.md" })],
  });
  expect(result.files[0]?.content).toContain("Rework count: 1");
  expect(result.files[0]?.content).toContain("Original task");
  expect(result.files[0]?.content).toContain("include the request");
  expect(result.files[0]?.content).toContain('"type": "reflection"');
});

test("writes input artifacts under the run directory and returns path references", () => {
  const root = mkdtempSync(join(tmpdir(), "pevr-inputs-"));
  tmpRoots.push(root);
  const refs = writePevrStepInputArtifacts(root, {
    step: "plan",
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
      path: join(realpathSync(root), "plan", "input", "task.md"),
      description: "Requested outcome and acceptance criteria",
    },
  ]);
  expect(existsSync(refs[0].path)).toBe(true);
  expect(readFileSync(refs[0].path, "utf8")).toBe("# Task\n");
});

test("rejects input artifact names that can escape the input directory", () => {
  const root = mkdtempSync(join(tmpdir(), "pevr-inputs-"));
  tmpRoots.push(root);

  for (const name of [
    "../escape.md",
    "nested/task.md",
    "/tmp/task.md",
    "..",
    "",
  ]) {
    expect(() =>
      writePevrStepInputArtifacts(root, {
        step: "plan",
        files: [
          {
            name,
            description: "Bad path",
            content: "bad",
          },
        ],
      }),
    ).toThrow(/PEVR input artifact name/u);
  }
});

test("rejects step names that can escape the run directory at runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "pevr-inputs-"));
  tmpRoots.push(root);

  expect(() =>
    writePevrStepInputArtifacts(root, {
      step: "../../outside" as "plan",
      files: [
        {
          name: "task.md",
          description: "Task",
          content: "bad",
        },
      ],
    }),
  ).toThrow(/Invalid PEVR step/u);
});

test("rejects symlinked input directories before writing artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "pevr-inputs-"));
  const outside = mkdtempSync(join(tmpdir(), "pevr-outside-"));
  tmpRoots.push(root, outside);
  mkdirSync(join(root, "plan"), { recursive: true });
  symlinkSync(outside, join(root, "plan", "input"), "dir");

  expect(() =>
    writePevrStepInputArtifacts(root, {
      step: "plan",
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
  const root = mkdtempSync(join(tmpdir(), "pevr-inputs-"));
  const outside = mkdtempSync(join(tmpdir(), "pevr-outside-"));
  tmpRoots.push(root, outside);
  mkdirSync(join(root, "plan", "input"), { recursive: true });
  const outsideFile = join(outside, "task.md");
  symlinkSync(outsideFile, join(root, "plan", "input", "task.md"));

  expect(() =>
    writePevrStepInputArtifacts(root, {
      step: "plan",
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
  const root = mkdtempSync(join(tmpdir(), "pevr-inputs-"));
  const outside = mkdtempSync(join(tmpdir(), "pevr-outside-"));
  tmpRoots.push(root, outside);
  mkdirSync(join(root, "plan", "input"), { recursive: true });
  const outsideFile = join(outside, "task.md");
  const artifactPath = join(root, "plan", "input", "task.md");
  writeFileSync(outsideFile, "outside\n");
  linkSync(outsideFile, artifactPath);

  const refs = writePevrStepInputArtifacts(root, {
    step: "plan",
    files: [
      {
        name: "task.md",
        description: "Task",
        content: "inside\n",
      },
    ],
  });

  expect(refs[0].path).toBe(
    join(realpathSync(root), "plan", "input", "task.md"),
  );
  expect(readFileSync(outsideFile, "utf8")).toBe("outside\n");
  expect(readFileSync(artifactPath, "utf8")).toBe("inside\n");
});
