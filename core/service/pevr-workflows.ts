import { actorFor, pevrWorkflowJSON, S, ServiceError } from "./shared.ts";

const MAX_NAME_LENGTH = 64;

function normalizeName(value: unknown): string {
  if (typeof value !== "string")
    throw new ServiceError(422, "name is required");
  const name = value.trim();
  if (!name) throw new ServiceError(422, "name is required");
  if (name.length > MAX_NAME_LENGTH)
    throw new ServiceError(422, "name must be 64 characters or fewer");
  return name;
}

function normalizeText(value: unknown, field: string): string {
  if (value == null) return "";
  if (typeof value !== "string")
    throw new ServiceError(422, `${field} must be a string`);
  return value;
}

function ensureUniqueName(name: string, exceptId?: number): void {
  const existing = S.getPevrWorkflowByName(name);
  if (existing && existing.id !== exceptId)
    throw new ServiceError(422, "workflow name must be unique");
}

function workflowOr404(name: string) {
  const workflow = S.getPevrWorkflowByName(normalizeName(name));
  if (!workflow) throw new ServiceError(404, "Not Found");
  return workflow;
}

export const pevrWorkflows = {
  list() {
    return S.listPevrWorkflows().map(pevrWorkflowJSON);
  },

  get(name: string) {
    return pevrWorkflowJSON(workflowOr404(name));
  },

  create(
    input: {
      name: string;
      description?: string;
      plan_prompt?: string;
      execute_prompt?: string;
      verify_prompt?: string;
      reflect_prompt?: string;
    },
    sessionId?: string | null,
  ) {
    const name = normalizeName(input.name);
    ensureUniqueName(name);
    const row = S.createPevrWorkflow({
      name,
      description: normalizeText(input.description, "description"),
      planPrompt: normalizeText(input.plan_prompt, "plan_prompt"),
      executePrompt: normalizeText(input.execute_prompt, "execute_prompt"),
      verifyPrompt: normalizeText(input.verify_prompt, "verify_prompt"),
      reflectPrompt: normalizeText(input.reflect_prompt, "reflect_prompt"),
    });
    S.emitEvent(null, "pevr_workflow.created", actorFor(sessionId), {
      id: row.id,
      name: row.name,
    });
    return pevrWorkflowJSON(row);
  },

  update(
    name: string,
    patch: {
      name?: string;
      description?: string;
      plan_prompt?: string;
      execute_prompt?: string;
      verify_prompt?: string;
      reflect_prompt?: string;
    },
    sessionId?: string | null,
  ) {
    const existing = workflowOr404(name);
    const nextName =
      patch.name !== undefined ? normalizeName(patch.name) : undefined;
    if (nextName !== undefined) ensureUniqueName(nextName, existing.id);
    const updated = S.updatePevrWorkflow(existing.id, {
      name: nextName,
      description:
        patch.description !== undefined
          ? normalizeText(patch.description, "description")
          : undefined,
      planPrompt:
        patch.plan_prompt !== undefined
          ? normalizeText(patch.plan_prompt, "plan_prompt")
          : undefined,
      executePrompt:
        patch.execute_prompt !== undefined
          ? normalizeText(patch.execute_prompt, "execute_prompt")
          : undefined,
      verifyPrompt:
        patch.verify_prompt !== undefined
          ? normalizeText(patch.verify_prompt, "verify_prompt")
          : undefined,
      reflectPrompt:
        patch.reflect_prompt !== undefined
          ? normalizeText(patch.reflect_prompt, "reflect_prompt")
          : undefined,
    });
    S.emitEvent(null, "pevr_workflow.updated", actorFor(sessionId), {
      id: existing.id,
      name: updated!.name,
    });
    return pevrWorkflowJSON(updated!);
  },

  delete(name: string, sessionId?: string | null) {
    const existing = workflowOr404(name);
    if (S.countActivePevrRunsForWorkflow(existing.id) > 0)
      throw new ServiceError(
        409,
        "workflow is referenced by an active PEVR run",
      );
    S.deletePevrWorkflow(existing.id);
    S.emitEvent(null, "pevr_workflow.deleted", actorFor(sessionId), {
      id: existing.id,
      name: existing.name,
    });
    return { ok: true };
  },
};
