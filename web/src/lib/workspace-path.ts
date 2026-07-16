export function workspacePath(name: string): string {
  return `/r/w/${encodeURIComponent(name)}`;
}
