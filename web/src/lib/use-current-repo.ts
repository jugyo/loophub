import { useRouterState } from "@tanstack/react-router";

// The "owner/repo" of the repo-scoped route currently in view, or null on non-repo screens
// (home, archived), as a primitive string. The terminal reads this once at mount to pick its
// cwd (a repo's base dir, or $HOME when null); the running session is never re-keyed, so later
// navigation — repo switches included — does not respawn or move it (see terminal-view.tsx).
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
