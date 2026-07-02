import { useRouterState } from "@tanstack/react-router";

// The "owner/repo" of the repo-scoped route currently in view, or null on non-repo screens
// (home, archived), as a primitive string.
export function useCurrentRepo(): string | null {
  return useRouterState({
    select: (s) => {
      for (let i = s.matches.length - 1; i >= 0; i--) {
        const p = s.matches[i].params as { owner?: string; repo?: string };
        if (p.owner && p.repo) return `${p.owner}/${p.repo}`;
      }
      return null;
    },
  });
}
