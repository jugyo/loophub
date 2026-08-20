// Directory tree over changed-file paths, for the diff dialog's "Changed files" sidebar. Building
// the tree stays on the client: the wire format is a flat file list.

export type FileTreeNode<T> =
  | { kind: "file"; name: string; path: string; entry: T }
  | {
      kind: "directory";
      name: string;
      path: string;
      children: FileTreeNode<T>[];
    };

type DirectoryBuilder<T> = {
  kind: "directory";
  name: string;
  path: string;
  children: Array<
    DirectoryBuilder<T> | { kind: "file"; name: string; path: string; entry: T }
  >;
  directories: Map<string, DirectoryBuilder<T>>;
};

function directoryBuilder<T>(name: string, path: string): DirectoryBuilder<T> {
  return {
    kind: "directory",
    name,
    path,
    children: [],
    directories: new Map(),
  };
}

// A directory whose only child is another directory is shown as one row ("web/src"), the way
// GitHub's file tree does.
function collapse<T>(node: DirectoryBuilder<T>): FileTreeNode<T> {
  let current = node;
  let name = node.name;
  while (
    current.children.length === 1 &&
    current.children[0].kind === "directory"
  ) {
    current = current.children[0];
    name = `${name}/${current.name}`;
  }
  return {
    kind: "directory",
    name,
    path: current.path,
    children: current.children.map((child) =>
      child.kind === "directory" ? collapse(child) : child,
    ),
  };
}

/**
 * Group entries into a directory tree by their path. Entries keep their input order: a directory
 * appears where its first entry did, and siblings follow the order they were first seen.
 */
export function buildFileTree<T>(
  entries: readonly T[],
  pathOf: (entry: T) => string,
): FileTreeNode<T>[] {
  const root = directoryBuilder<T>("", "");
  for (const entry of entries) {
    const path = pathOf(entry);
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const name = segments[segments.length - 1];
    let parent = root;
    for (const segment of segments.slice(0, -1)) {
      const childPath = parent.path ? `${parent.path}/${segment}` : segment;
      let child = parent.directories.get(segment);
      if (!child) {
        child = directoryBuilder<T>(segment, childPath);
        parent.directories.set(segment, child);
        parent.children.push(child);
      }
      parent = child;
    }
    parent.children.push({ kind: "file", name, path, entry });
  }
  return root.children.map((child) =>
    child.kind === "directory" ? collapse(child) : child,
  );
}

export type FileTreeRow<T> = { node: FileTreeNode<T>; depth: number };

/** Rows to render for a tree, in display order, skipping children of collapsed directories. */
export function visibleFileTreeRows<T>(
  nodes: readonly FileTreeNode<T>[],
  collapsed: ReadonlySet<string>,
  depth = 0,
): FileTreeRow<T>[] {
  return nodes.flatMap((node) => {
    const row = { node, depth };
    if (node.kind === "file" || collapsed.has(node.path)) return [row];
    return [row, ...visibleFileTreeRows(node.children, collapsed, depth + 1)];
  });
}
