// Link to the repo settings screen (/r/:owner/:repo/settings, #561) in the repo dashboard
// header. Rename/Archive/PR-action used to live behind a "…" overflow menu here; they moved
// to the dedicated settings screen, so this is now a plain, always-visible entry point —
// no menu to open.

import { Link } from "@tanstack/react-router";
import { Settings } from "lucide-react";

export function RepoSettingsLink({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  return (
    <Link
      to="/r/$owner/$repo/settings"
      params={{ owner, repo }}
      className="inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <Settings className="size-4" />
      Settings
    </Link>
  );
}
