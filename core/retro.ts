// Pure, side-effect-free validation/normalization for retro rubric scores and
// free-form findings (loop-retrospective-design.ja.md §2). service.ts composes
// these before persisting to `retros`. Keeping the shape checks here — not inline
// in service.ts — mirrors worktree-prune.ts: the decisioning is unit-testable
// without spawning the CLI or opening a DB.

export const RUBRIC_SEVERITIES = ["ok", "warn", "bad"] as const;
export type Severity = (typeof RUBRIC_SEVERITIES)[number];

// retros.status lifecycle. MVP only writes `draft`; reviewed/applied/dismissed
// are Phase 2 transitions (design §4.2) but accepted so the column is forward-compatible.
export const RETRO_STATUSES = [
  "draft",
  "reviewed",
  "applied",
  "dismissed",
] as const;
export type RetroStatus = (typeof RETRO_STATUSES)[number];

// One rubric observation: {id, signal, value, severity, note} (design §2).
export interface RubricItem {
  id: string;
  signal: string;
  value: string | number | boolean | null;
  severity: Severity;
  note: string;
}

// One free-form finding: {category, severity, note, evidence_ref, proposed_action?} (design §2).
export interface Finding {
  category: string;
  severity: Severity;
  note: string;
  evidence_ref: string;
  proposed_action?: string;
}

// Thrown on bad input shape; service.ts maps it to a 422.
export class RetroValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetroValidationError";
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isSeverity(v: unknown): v is Severity {
  return (
    typeof v === "string" &&
    (RUBRIC_SEVERITIES as readonly string[]).includes(v)
  );
}

function reqString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const v = obj[key];
  if (typeof v !== "string" || v.trim() === "") {
    throw new RetroValidationError(
      `${where}: "${key}" must be a non-empty string`,
    );
  }
  return v;
}

function optString(
  obj: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const v = obj[key];
  if (v === undefined || v === null) return "";
  if (typeof v !== "string") {
    throw new RetroValidationError(`${where}: "${key}" must be a string`);
  }
  return v;
}

function severityOf(obj: Record<string, unknown>, where: string): Severity {
  if (!isSeverity(obj.severity)) {
    throw new RetroValidationError(
      `${where}: "severity" must be one of ${RUBRIC_SEVERITIES.join("|")}`,
    );
  }
  return obj.severity;
}

// Validate + normalize the rubric array. Returns a fresh array of canonical
// RubricItem objects (extra keys dropped) so callers persist a stable shape.
export function validateRubric(input: unknown): RubricItem[] {
  if (!Array.isArray(input)) {
    throw new RetroValidationError("rubric must be an array");
  }
  return input.map((raw, i): RubricItem => {
    const where = `rubric[${i}]`;
    if (!isPlainObject(raw)) {
      throw new RetroValidationError(`${where} must be an object`);
    }
    let value: RubricItem["value"];
    const v = raw.value;
    if (v === undefined || v === null) value = null;
    else if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    )
      value = v;
    else
      throw new RetroValidationError(
        `${where}: "value" must be a string, number, boolean, or null`,
      );
    return {
      id: reqString(raw, "id", where),
      signal: reqString(raw, "signal", where),
      value,
      severity: severityOf(raw, where),
      note: optString(raw, "note", where),
    };
  });
}

// Validate + normalize the findings array. proposed_action is optional and only
// kept when a non-empty string is provided.
export function validateFindings(input: unknown): Finding[] {
  if (!Array.isArray(input)) {
    throw new RetroValidationError("findings must be an array");
  }
  return input.map((raw, i): Finding => {
    const where = `findings[${i}]`;
    if (!isPlainObject(raw)) {
      throw new RetroValidationError(`${where} must be an object`);
    }
    const finding: Finding = {
      category: reqString(raw, "category", where),
      severity: severityOf(raw, where),
      note: reqString(raw, "note", where),
      evidence_ref: optString(raw, "evidence_ref", where),
    };
    const action = raw.proposed_action;
    if (action !== undefined && action !== null) {
      if (typeof action !== "string") {
        throw new RetroValidationError(
          `${where}: "proposed_action" must be a string`,
        );
      }
      if (action.trim() !== "") finding.proposed_action = action;
    }
    return finding;
  });
}

export function isRetroStatus(v: unknown): v is RetroStatus {
  return (
    typeof v === "string" && (RETRO_STATUSES as readonly string[]).includes(v)
  );
}
