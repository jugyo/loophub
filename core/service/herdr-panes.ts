import { repoOr404, S, ServiceError } from "./shared.ts";

function required(value: string, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new ServiceError(422, `${name} is required`);
  return normalized;
}

export const herdrPanes = {
  registerForResource(input: {
    repo: string;
    launchId: string;
    paneId: string;
    sessionName: string;
    displayName: string;
    origin: string;
    resourceKind: string;
    resourceKey: string;
  }) {
    const repo = repoOr404(input.repo);
    const launchId = required(input.launchId, "launchId");
    S.registerHerdrPane({
      repoId: repo.id,
      launchId,
      paneId: required(input.paneId, "paneId"),
      sessionName: required(input.sessionName, "sessionName"),
      displayName: required(input.displayName, "displayName"),
      origin: required(input.origin, "origin"),
    });
    return S.linkHerdrPaneResource({
      repoId: repo.id,
      launchId,
      resourceKind: required(input.resourceKind, "resourceKind"),
      resourceKey: required(input.resourceKey, "resourceKey"),
    });
  },

  register(input: {
    repo: string;
    launchId: string;
    paneId: string;
    sessionName: string;
    displayName: string;
    origin: string;
    lifecycleManaged?: boolean;
  }) {
    const repo = repoOr404(input.repo);
    return S.registerHerdrPane({
      repoId: repo.id,
      launchId: required(input.launchId, "launchId"),
      paneId: required(input.paneId, "paneId"),
      sessionName: required(input.sessionName, "sessionName"),
      displayName: required(input.displayName, "displayName"),
      origin: required(input.origin, "origin"),
      lifecycleManaged: input.lifecycleManaged,
    });
  },

  link(input: {
    repo: string;
    launchId: string;
    resourceKind: string;
    resourceKey: string;
  }) {
    const repo = repoOr404(input.repo);
    return S.linkHerdrPaneResource({
      repoId: repo.id,
      launchId: required(input.launchId, "launchId"),
      resourceKind: required(input.resourceKind, "resourceKind"),
      resourceKey: required(input.resourceKey, "resourceKey"),
    });
  },

  listForResource(input: {
    repo: string;
    resourceKind: string;
    resourceKey: string;
  }) {
    const repo = repoOr404(input.repo);
    return S.listHerdrPanesForResource({
      repoId: repo.id,
      resourceKind: required(input.resourceKind, "resourceKind"),
      resourceKey: required(input.resourceKey, "resourceKey"),
    });
  },

  claim(input: {
    repo: string;
    launchId: string;
    resourceKind: string;
    resourceKey: string;
    purpose: string;
  }) {
    const repo = repoOr404(input.repo);
    return S.addHerdrPaneClaim({
      repoId: repo.id,
      launchId: required(input.launchId, "launchId"),
      resourceKind: required(input.resourceKind, "resourceKind"),
      resourceKey: required(input.resourceKey, "resourceKey"),
      purpose: required(input.purpose, "purpose"),
    });
  },

  claimsForResource(input: {
    repo: string;
    resourceKind: string;
    resourceKey: string;
  }) {
    const repo = repoOr404(input.repo);
    return S.listHerdrPaneClaimsForResource({
      repoId: repo.id,
      resourceKind: required(input.resourceKind, "resourceKind"),
      resourceKey: required(input.resourceKey, "resourceKey"),
    });
  },

  releaseClaimsForResource(input: {
    repo: string;
    resourceKind: string;
    resourceKey: string;
  }) {
    const repo = repoOr404(input.repo);
    return S.releaseHerdrPaneClaimsForResource({
      repoId: repo.id,
      resourceKind: required(input.resourceKind, "resourceKind"),
      resourceKey: required(input.resourceKey, "resourceKey"),
    });
  },
};
