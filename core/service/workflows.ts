import { db } from "../db.ts";
import { ServiceError } from "../errors.ts";
import { type WorkflowContractsWire, workflowJSON } from "../serialize.ts";
import * as S from "../store.ts";
import { workflowContracts } from "../workflow/contracts.ts";
import { workflowContractLanguage } from "./settings.ts";
import { actorFor, repoOr404 } from "./shared.ts";

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

function ensureUniqueName(
  name: string,
  repoId: number | null,
  exceptId?: number,
): void {
  const existing = S.getWorkflowByName(name, repoId);
  if (existing && existing.id !== exceptId)
    throw new ServiceError(422, "workflow name must be unique");
}

function workflowOr404(name: string, repoId: number | null = null) {
  const workflow = S.getWorkflowByName(normalizeName(name), repoId);
  if (!workflow) throw new ServiceError(404, "Not Found");
  return workflow;
}

function workflowByIdOr404(id: number) {
  const workflow = S.getWorkflowById(id);
  if (!workflow) throw new ServiceError(404, "Not Found");
  return workflow;
}

function scopePayload(row: S.WorkflowRow) {
  return row.repo_id === null
    ? { kind: "global" as const }
    : { kind: "repository" as const, repo_id: row.repo_id };
}

function updateWorkflow(
  existing: S.WorkflowRow,
  patch: {
    name?: string;
    description?: string;
    execute_prompt?: string;
    verify_prompt?: string;
  },
  sessionId?: string | null,
) {
  const nextName =
    patch.name !== undefined ? normalizeName(patch.name) : undefined;
  if (nextName !== undefined)
    ensureUniqueName(nextName, existing.repo_id, existing.id);
  return db.transaction(() => {
    const updated = S.updateWorkflow(existing.id, {
      name: nextName,
      description:
        patch.description !== undefined
          ? normalizeText(patch.description, "description")
          : undefined,
      executePrompt:
        patch.execute_prompt !== undefined
          ? normalizeText(patch.execute_prompt, "execute_prompt")
          : undefined,
      verifyPrompt:
        patch.verify_prompt !== undefined
          ? normalizeText(patch.verify_prompt, "verify_prompt")
          : undefined,
    })!;
    S.emitEvent(null, "workflow.updated", actorFor(sessionId), {
      id: existing.id,
      name: updated.name,
      scope: scopePayload(updated),
    });
    return workflowJSON(updated);
  });
}

export const workflows = {
  contracts(): WorkflowContractsWire {
    return workflowContracts(workflowContractLanguage());
  },

  list(
    input: { scope?: "global" | { repo: string }; applicableTo?: string } = {},
  ) {
    if (input.scope !== undefined && input.applicableTo !== undefined)
      throw new ServiceError(
        422,
        "scope and applicableTo are mutually exclusive",
      );
    if (input.applicableTo !== undefined) {
      const repo = repoOr404(input.applicableTo);
      return S.listWorkflows({ applicableToRepoId: repo.id }).map(workflowJSON);
    }
    if (input.scope && input.scope !== "global") {
      const repo = repoOr404(input.scope.repo);
      return S.listWorkflows({ repoId: repo.id }).map(workflowJSON);
    }
    return S.listWorkflows({ repoId: null }).map(workflowJSON);
  },

  get(name: string, repo?: string) {
    const repoId = repo === undefined ? null : repoOr404(repo).id;
    return workflowJSON(workflowOr404(name, repoId));
  },

  create(
    input: {
      name: string;
      description?: string;
      execute_prompt?: string;
      verify_prompt?: string;
      repo?: string;
    },
    sessionId?: string | null,
  ) {
    const name = normalizeName(input.name);
    const repo = input.repo === undefined ? null : repoOr404(input.repo);
    ensureUniqueName(name, repo?.id ?? null);
    return db.transaction(() => {
      const row = S.createWorkflow({
        repoId: repo?.id ?? null,
        name,
        description: normalizeText(input.description, "description"),
        executePrompt: normalizeText(input.execute_prompt, "execute_prompt"),
        verifyPrompt: normalizeText(input.verify_prompt, "verify_prompt"),
      });
      S.emitEvent(null, "workflow.created", actorFor(sessionId), {
        id: row.id,
        name: row.name,
        scope: scopePayload(row),
      });
      return workflowJSON(row);
    });
  },

  update(
    name: string,
    patch: {
      name?: string;
      description?: string;
      execute_prompt?: string;
      verify_prompt?: string;
    },
    sessionId?: string | null,
    repo?: string,
  ) {
    const repoId = repo === undefined ? null : repoOr404(repo).id;
    return updateWorkflow(workflowOr404(name, repoId), patch, sessionId);
  },

  updateById(
    id: number,
    patch: {
      name?: string;
      description?: string;
      execute_prompt?: string;
      verify_prompt?: string;
    },
    sessionId?: string | null,
  ) {
    return updateWorkflow(workflowByIdOr404(id), patch, sessionId);
  },

  archive(name: string, sessionId?: string | null, repo?: string) {
    const repoId = repo === undefined ? null : repoOr404(repo).id;
    const existing = workflowOr404(name, repoId);
    return db.transaction(() => {
      const archived = S.archiveWorkflow(existing.id);
      S.emitEvent(null, "workflow.archived", actorFor(sessionId), {
        id: existing.id,
        name: existing.name,
        scope: scopePayload(existing),
      });
      return workflowJSON(archived!);
    });
  },

  archiveById(id: number, sessionId?: string | null) {
    const existing = workflowByIdOr404(id);
    return db.transaction(() => {
      const archived = S.archiveWorkflow(existing.id)!;
      S.emitEvent(null, "workflow.archived", actorFor(sessionId), {
        id: existing.id,
        name: existing.name,
        scope: scopePayload(existing),
      });
      return workflowJSON(archived);
    });
  },

  delete(name: string, sessionId?: string | null, repo?: string) {
    const repoId = repo === undefined ? null : repoOr404(repo).id;
    const existing = workflowOr404(name, repoId);
    if (S.countActiveWorkflowRunsForWorkflow(existing.id) > 0)
      throw new ServiceError(
        409,
        "workflow is referenced by an active workflow run",
      );
    db.transaction(() => {
      S.deleteWorkflow(existing.id);
      S.emitEvent(null, "workflow.deleted", actorFor(sessionId), {
        id: existing.id,
        name: existing.name,
        scope: scopePayload(existing),
      });
    });
    return { ok: true };
  },

  deleteById(id: number, sessionId?: string | null) {
    const existing = workflowByIdOr404(id);
    if (S.countActiveWorkflowRunsForWorkflow(existing.id) > 0)
      throw new ServiceError(
        409,
        "workflow is referenced by an active workflow run",
      );
    db.transaction(() => {
      S.deleteWorkflow(existing.id);
      S.emitEvent(null, "workflow.deleted", actorFor(sessionId), {
        id: existing.id,
        name: existing.name,
        scope: scopePayload(existing),
      });
    });
    return { ok: true };
  },
};
