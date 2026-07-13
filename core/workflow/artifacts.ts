export type WorkflowArtifactType = "execution-report" | "verdict";

export type WorkflowArtifact =
  | WorkflowExecutionReportArtifact
  | WorkflowVerdictArtifact;

export type WorkflowExecutionReportArtifact = {
  type: "execution-report";
  summary: string;
  acceptance: WorkflowAcceptanceResult[];
  tests: WorkflowTestResult[];
  evidence: WorkflowEvidence[];
  reflection: WorkflowReflection;
};

export type WorkflowAcceptanceResult = {
  criterion: string;
  met: boolean;
  note: string;
};

export type WorkflowTestResult = {
  command: string;
  passed: boolean;
  excerpt: string;
};

export type WorkflowEvidence = {
  kind: "test" | "cli" | "screenshot" | "na";
  description: string;
  path?: string;
};

export type WorkflowVerdictArtifact = {
  type: "verdict";
  event: "pass" | "request_changes";
  summary: string;
  findings: WorkflowFinding[];
};

export type WorkflowFinding = {
  file: string;
  line?: number;
  problem: string;
  expected: string;
};

export type WorkflowReflection = {
  went_well: string[];
  friction: WorkflowFriction[];
  suggestions: WorkflowSuggestion[];
  followups: WorkflowFollowup[];
};

export type WorkflowFriction = {
  what: string;
  cause: string;
};

export type WorkflowSuggestion = {
  target: "step-prompt" | "contract" | "engine";
  text: string;
};

export type WorkflowFollowup = {
  title: string;
  rationale: string;
};

export type WorkflowArtifactViolation = {
  path: string;
  message: string;
};

export type WorkflowArtifactValidationResult =
  | { ok: true; artifact: WorkflowArtifact }
  | { ok: false; violations: WorkflowArtifactViolation[] };

const ARTIFACT_TYPES = ["execution-report", "verdict"] as const;

export function parseWorkflowArtifactJson(
  json: string,
): WorkflowArtifactValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    const message = e instanceof Error ? e.message : "invalid JSON";
    return {
      ok: false,
      violations: [{ path: "$", message: `Invalid JSON: ${message}` }],
    };
  }
  return validateWorkflowArtifact(value);
}

export function validateWorkflowArtifact(
  value: unknown,
): WorkflowArtifactValidationResult {
  const violations: WorkflowArtifactViolation[] = [];
  if (!isRecord(value)) {
    violations.push({ path: "$", message: "Expected object" });
    return { ok: false, violations };
  }

  requireEnum(value, "$.type", "type", ARTIFACT_TYPES, violations);
  if (violations.some((v) => v.path === "$.type")) {
    return { ok: false, violations };
  }

  switch (value.type) {
    case "execution-report":
      validateExecutionReport(value, violations);
      break;
    case "verdict":
      validateVerdict(value, violations);
      break;
  }

  if (violations.length > 0) {
    return { ok: false, violations };
  }
  return { ok: true, artifact: value as WorkflowArtifact };
}

function validateExecutionReport(
  value: Record<string, unknown>,
  violations: WorkflowArtifactViolation[],
): void {
  rejectUnknownKeys(
    value,
    "$",
    ["type", "summary", "acceptance", "tests", "evidence", "reflection"],
    violations,
  );
  requireNonEmptyString(value, "$.summary", "summary", violations);
  requireNonEmptyObjectArray(
    value,
    "$.acceptance",
    "acceptance",
    violations,
    (item, path) => {
      rejectUnknownKeys(item, path, ["criterion", "met", "note"], violations);
      requireNonEmptyString(item, `${path}.criterion`, "criterion", violations);
      requireBoolean(item, `${path}.met`, "met", violations);
      requireNonEmptyString(item, `${path}.note`, "note", violations);
    },
  );
  requireNonEmptyObjectArray(
    value,
    "$.tests",
    "tests",
    violations,
    (item, path) => {
      rejectUnknownKeys(
        item,
        path,
        ["command", "passed", "excerpt"],
        violations,
      );
      requireNonEmptyString(item, `${path}.command`, "command", violations);
      requireBoolean(item, `${path}.passed`, "passed", violations);
      requireNonEmptyString(item, `${path}.excerpt`, "excerpt", violations);
    },
  );
  requireNonEmptyObjectArray(
    value,
    "$.evidence",
    "evidence",
    violations,
    (item, path) => {
      rejectUnknownKeys(
        item,
        path,
        ["kind", "description", "path"],
        violations,
      );
      requireEnum(
        item,
        `${path}.kind`,
        "kind",
        ["test", "cli", "screenshot", "na"],
        violations,
      );
      requireNonEmptyString(
        item,
        `${path}.description`,
        "description",
        violations,
      );
      if (item.kind === "screenshot" && !Object.hasOwn(item, "path")) {
        violations.push({
          path: `${path}.path`,
          message: "Required field is missing for screenshot evidence",
        });
        return;
      }
      if (Object.hasOwn(item, "path")) {
        requireEvidencePath(item, `${path}.path`, "path", violations);
      }
    },
  );
  if (!isRecord(value.reflection)) {
    violations.push({
      path: "$.reflection",
      message: Object.hasOwn(value, "reflection")
        ? "Expected object"
        : "Required field is missing",
    });
  } else {
    validateReflection(value.reflection, "$.reflection", violations);
  }
}

function validateVerdict(
  value: Record<string, unknown>,
  violations: WorkflowArtifactViolation[],
): void {
  rejectUnknownKeys(
    value,
    "$",
    ["type", "event", "summary", "findings"],
    violations,
  );
  requireEnum(
    value,
    "$.event",
    "event",
    ["pass", "request_changes"],
    violations,
  );
  requireNonEmptyString(value, "$.summary", "summary", violations);
  const findingsBefore = violations.length;
  requireObjectArray(
    value,
    "$.findings",
    "findings",
    violations,
    (item, path) => {
      rejectUnknownKeys(
        item,
        path,
        ["file", "line", "problem", "expected"],
        violations,
      );
      requireNonEmptyString(item, `${path}.file`, "file", violations);
      if (Object.hasOwn(item, "line")) {
        requirePositiveInteger(item, `${path}.line`, "line", violations);
      }
      requireNonEmptyString(item, `${path}.problem`, "problem", violations);
      requireNonEmptyString(item, `${path}.expected`, "expected", violations);
    },
  );
  if (
    value.event === "request_changes" &&
    findingsBefore === violations.length &&
    Array.isArray(value.findings) &&
    value.findings.length === 0
  ) {
    violations.push({
      path: "$.findings",
      message: "Expected at least 1 item when event is request_changes",
    });
  }
}

function validateReflection(
  value: Record<string, unknown>,
  path: string,
  violations: WorkflowArtifactViolation[],
): void {
  rejectUnknownKeys(
    value,
    path,
    ["went_well", "friction", "suggestions", "followups"],
    violations,
  );
  requireNonEmptyStringArray(
    value,
    `${path}.went_well`,
    "went_well",
    violations,
  );
  requireObjectArray(
    value,
    `${path}.friction`,
    "friction",
    violations,
    (item, path) => {
      rejectUnknownKeys(item, path, ["what", "cause"], violations);
      requireNonEmptyString(item, `${path}.what`, "what", violations);
      requireNonEmptyString(item, `${path}.cause`, "cause", violations);
    },
  );
  requireObjectArray(
    value,
    `${path}.suggestions`,
    "suggestions",
    violations,
    (item, path) => {
      rejectUnknownKeys(item, path, ["target", "text"], violations);
      requireEnum(
        item,
        `${path}.target`,
        "target",
        ["step-prompt", "contract", "engine"],
        violations,
      );
      requireNonEmptyString(item, `${path}.text`, "text", violations);
    },
  );
  requireObjectArray(
    value,
    `${path}.followups`,
    "followups",
    violations,
    (item, path) => {
      rejectUnknownKeys(item, path, ["title", "rationale"], violations);
      requireNonEmptyString(item, `${path}.title`, "title", violations);
      requireNonEmptyString(item, `${path}.rationale`, "rationale", violations);
    },
  );
}

function requireNonEmptyString(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
): void {
  if (!Object.hasOwn(obj, key)) {
    violations.push({ path, message: "Required field is missing" });
    return;
  }
  if (typeof obj[key] !== "string") {
    violations.push({ path, message: "Expected string" });
    return;
  }
  if (obj[key].trim() === "") {
    violations.push({ path, message: "Expected non-empty string" });
  }
}

function requireBoolean(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
): void {
  if (!Object.hasOwn(obj, key)) {
    violations.push({ path, message: "Required field is missing" });
    return;
  }
  if (typeof obj[key] !== "boolean") {
    violations.push({ path, message: "Expected boolean" });
  }
}

function requirePositiveInteger(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
): void {
  if (
    typeof obj[key] !== "number" ||
    !Number.isInteger(obj[key]) ||
    obj[key] < 1
  ) {
    violations.push({ path, message: "Expected positive integer" });
  }
}

function requireEvidencePath(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
): void {
  requireNonEmptyString(obj, path, key, violations);
  if (typeof obj[key] !== "string" || obj[key].trim() === "") {
    return;
  }

  const value = obj[key];
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    violations.push({
      path,
      message: "Expected path without control characters",
    });
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    violations.push({ path, message: "Expected relative path" });
  }
  if (value.split(/[\\/]+/u).includes("..")) {
    violations.push({
      path,
      message: "Expected path without parent traversal",
    });
  }
}

function requireEnum<T extends string>(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  allowed: readonly T[],
  violations: WorkflowArtifactViolation[],
): void {
  if (!Object.hasOwn(obj, key)) {
    violations.push({ path, message: "Required field is missing" });
    return;
  }
  if (typeof obj[key] !== "string" || !allowed.includes(obj[key] as T)) {
    violations.push({
      path,
      message: `Expected one of: ${allowed.join(", ")}`,
    });
  }
}

function requireNonEmptyStringArray(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
): void {
  const array = requireArray(obj, path, key, violations);
  if (!array) {
    return;
  }
  if (array.length === 0) {
    violations.push({ path, message: "Expected at least 1 item" });
  }
  validateStringArrayItems(array, path, violations);
}

function requireObjectArray(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
  validateItem: (item: Record<string, unknown>, path: string) => void,
): void {
  const array = requireArray(obj, path, key, violations);
  if (!array) {
    return;
  }
  validateObjectArrayItems(array, path, violations, validateItem);
}

function requireNonEmptyObjectArray(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
  validateItem: (item: Record<string, unknown>, path: string) => void,
): void {
  const array = requireArray(obj, path, key, violations);
  if (!array) {
    return;
  }
  if (array.length === 0) {
    violations.push({ path, message: "Expected at least 1 item" });
  }
  validateObjectArrayItems(array, path, violations, validateItem);
}

function requireArray(
  obj: Record<string, unknown>,
  path: string,
  key: string,
  violations: WorkflowArtifactViolation[],
): unknown[] | null {
  if (!Object.hasOwn(obj, key)) {
    violations.push({ path, message: "Required field is missing" });
    return null;
  }
  if (!Array.isArray(obj[key])) {
    violations.push({ path, message: "Expected array" });
    return null;
  }
  return obj[key];
}

function validateStringArrayItems(
  array: unknown[],
  path: string,
  violations: WorkflowArtifactViolation[],
): void {
  array.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (typeof item !== "string") {
      violations.push({ path: itemPath, message: "Expected string" });
      return;
    }
    if (item.trim() === "") {
      violations.push({ path: itemPath, message: "Expected non-empty string" });
    }
  });
}

function validateObjectArrayItems(
  array: unknown[],
  path: string,
  violations: WorkflowArtifactViolation[],
  validateItem: (item: Record<string, unknown>, path: string) => void,
): void {
  array.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(item)) {
      violations.push({ path: itemPath, message: "Expected object" });
      return;
    }
    validateItem(item, itemPath);
  });
}

function rejectUnknownKeys(
  obj: Record<string, unknown>,
  path: string,
  knownKeys: readonly string[],
  violations: WorkflowArtifactViolation[],
): void {
  const known = new Set(knownKeys);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      violations.push({
        path: path === "$" ? `$.${key}` : `${path}.${key}`,
        message: "Unknown field",
      });
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
