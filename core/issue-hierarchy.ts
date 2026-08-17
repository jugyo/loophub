export const MAX_ISSUE_DEPTH = 3;

export interface IssueFacts {
  id: number;
  number: number;
  repoId: number;
  kind: "issue" | "pull";
  targetBranch: string | null;
}

export type AttachRejection =
  | { kind: "not_an_issue" }
  | { kind: "cross_repo" }
  | { kind: "self" }
  | { kind: "cycle"; ancestorNumber: number }
  | {
      kind: "workspace_mismatch";
      parentWorkspace: string;
      childWorkspace: string;
    }
  | { kind: "parent_too_deep"; parentDepth: number }
  | {
      kind: "child_subtree_too_tall";
      parentDepth: number;
      childHeight: number;
    };

export function attachRejectionMessage(rejection: AttachRejection): string {
  switch (rejection.kind) {
    case "not_an_issue":
      return "parent and child must both be issues";
    case "cross_repo":
      return "parent and child must belong to the same repository";
    case "self":
      return "an issue cannot be its own parent";
    case "cycle":
      return `attaching would create a cycle through issue #${rejection.ancestorNumber}`;
    case "workspace_mismatch":
      return `parent and child must use the same workspace: ${rejection.parentWorkspace} != ${rejection.childWorkspace}`;
    case "parent_too_deep":
      return `parent would be at depth ${rejection.parentDepth}, but the maximum is ${MAX_ISSUE_DEPTH}`;
    case "child_subtree_too_tall":
      return `child subtree would reach depth ${rejection.parentDepth + rejection.childHeight}, but the maximum is ${MAX_ISSUE_DEPTH}`;
  }
}

export function effectiveWorkspace(
  targetBranch: string | null,
  defaultBranch: string,
): string {
  return targetBranch ?? defaultBranch;
}

export function canHaveSubIssues(depth: number): boolean {
  return depth < MAX_ISSUE_DEPTH;
}

export function rejectAttach(input: {
  child: IssueFacts;
  parent: IssueFacts;
  parentAncestorNumbers: number[];
  childSubtreeHeight: number;
  defaultBranch: string;
}): AttachRejection | null {
  const { child, parent } = input;

  if (child.kind !== "issue" || parent.kind !== "issue") {
    return { kind: "not_an_issue" };
  }
  if (child.repoId !== parent.repoId) return { kind: "cross_repo" };
  if (child.id === parent.id) return { kind: "self" };

  if (input.parentAncestorNumbers.includes(child.number)) {
    return { kind: "cycle", ancestorNumber: child.number };
  }

  const parentWorkspace = effectiveWorkspace(
    parent.targetBranch,
    input.defaultBranch,
  );
  const childWorkspace = effectiveWorkspace(
    child.targetBranch,
    input.defaultBranch,
  );
  if (parentWorkspace !== childWorkspace) {
    return {
      kind: "workspace_mismatch",
      parentWorkspace,
      childWorkspace,
    };
  }

  const parentDepth = input.parentAncestorNumbers.length + 1;
  if (!canHaveSubIssues(parentDepth)) {
    return { kind: "parent_too_deep", parentDepth };
  }
  if (parentDepth + input.childSubtreeHeight > MAX_ISSUE_DEPTH) {
    return {
      kind: "child_subtree_too_tall",
      parentDepth,
      childHeight: input.childSubtreeHeight,
    };
  }

  return null;
}
