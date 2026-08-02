// Dedicated per-repo settings screen (/r/:owner/:repo/settings, #561). Holds the
// repo-level actions that used to live in the repo dashboard header's "…" overflow
// menu — Rename, Archive/Unarchive, and the PR-action (merge mode) toggle — as their
// own screen instead of a cramped dropdown. Same RPCs/hooks as before (repos/rename,
// repos/setArchived, repos/mergeMode, repos/setMergeMode); only the presentation moved.

import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  Bot,
  Check,
  GitPullRequestArrow,
  Settings2,
  SquareKanban,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CodingAgent, MergeMode } from "@/api/types";
import { Button, disabledButtonStateClasses } from "@/components/ui/button";
import {
  CODING_AGENT_LABELS,
  EFFORT_SUGGESTIONS,
  MODEL_SUGGESTIONS,
} from "@/lib/agent-models";
import { cn } from "@/lib/utils";
import {
  useRenameRepo,
  useRepo,
  useRepoAgentConfig,
  useRepoMergeMode,
  useSetRepoAgentConfig,
  useSetRepoArchived,
  useSetRepoDefaultBranch,
  useSetRepoMergeMode,
} from "@/queries/repos";
import {
  useArchivedWorkspaces,
  useSetWorkspaceArchived,
} from "@/queries/workspaces";
import { CODING_AGENTS } from "../../../core/runtimes.ts";

const MERGE_MODE_LABELS: Record<MergeMode, string> = {
  merge: "Merge",
  github_pr: "Create PR on GitHub",
};

const REPO_SETTINGS_SECTIONS = [
  "general",
  "pull-requests",
  "coding-agent",
  "workspaces",
  "archive",
] as const;

export type RepoSettingsSection = (typeof REPO_SETTINGS_SECTIONS)[number];

type RepoSettingsPath =
  | "/r/$owner/$repo/settings"
  | "/r/$owner/$repo/settings/pull-requests"
  | "/r/$owner/$repo/settings/coding-agent"
  | "/r/$owner/$repo/settings/workspaces"
  | "/r/$owner/$repo/settings/archive";

const SETTINGS_NAV_ITEMS: Array<{
  id: RepoSettingsSection;
  label: string;
  description: string;
  icon: typeof Settings2;
  path: RepoSettingsPath;
}> = [
  {
    id: "general",
    label: "General",
    description: "Repository identity and base branch.",
    icon: Settings2,
    path: "/r/$owner/$repo/settings",
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    description: "Default action for pull requests.",
    icon: GitPullRequestArrow,
    path: "/r/$owner/$repo/settings/pull-requests",
  },
  {
    id: "coding-agent",
    label: "Coding agent",
    description: "Repository-specific agent defaults.",
    icon: Bot,
    path: "/r/$owner/$repo/settings/coding-agent",
  },
  {
    id: "workspaces",
    label: "Workspaces",
    description: "Archived workspace management.",
    icon: SquareKanban,
    path: "/r/$owner/$repo/settings/workspaces",
  },
  {
    id: "archive",
    label: "Archive",
    description: "Repository visibility and access.",
    icon: Archive,
    path: "/r/$owner/$repo/settings/archive",
  },
];

export function RepoSettingsPage({
  owner,
  repo,
  section,
}: {
  owner: string;
  repo: string;
  section: RepoSettingsSection;
}) {
  const { data } = useRepo(owner, repo);
  const loaded = data !== undefined;
  const archived = data?.archived ?? false;

  return (
    <div
      data-debug-component="RepoSettingsPage"
      className="mx-auto flex max-w-content items-start gap-8"
    >
      <aside className="sticky top-6 w-56 shrink-0 border-r pr-6">
        <h1 className="px-3 text-sm font-semibold">Repository settings</h1>
        <p className="mt-1 truncate px-3 text-xs text-muted-foreground">
          {owner}/{repo}
        </p>
        <nav aria-label="Repository settings" className="mt-5 space-y-1">
          {SETTINGS_NAV_ITEMS.map((item) => {
            const active = item.id === section;
            const Icon = item.icon;
            return (
              <Link
                key={item.id}
                to={item.path}
                params={{ owner, repo }}
                activeOptions={{ exact: true }}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0" aria-hidden="true" />
                {item.label}
              </Link>
            );
          })}
        </nav>
      </aside>

      <div
        role="region"
        aria-labelledby={`repo-settings-${section}-heading`}
        className="min-w-0 flex-1 pb-8"
      >
        <SectionHeader section={section} />
        {section === "general" ? (
          <>
            <RenameSection owner={owner} repo={repo} loaded={loaded} />
            <BaseBranchSection
              owner={owner}
              repo={repo}
              loaded={loaded}
              current={data?.default_branch ?? ""}
            />
          </>
        ) : null}
        {section === "pull-requests" ? (
          <MergeModeSection owner={owner} repo={repo} />
        ) : null}
        {section === "coding-agent" ? (
          <AgentConfigSection owner={owner} repo={repo} />
        ) : null}
        {section === "workspaces" ? (
          <ArchivedWorkspacesSection owner={owner} repo={repo} />
        ) : null}
        {section === "archive" ? (
          <ArchiveSection
            owner={owner}
            repo={repo}
            loaded={loaded}
            archived={archived}
          />
        ) : null}
      </div>
    </div>
  );
}

function SectionHeader({ section }: { section: RepoSettingsSection }) {
  const item = SETTINGS_NAV_ITEMS.find(
    (candidate) => candidate.id === section,
  )!;
  return (
    <header className="border-b pb-5">
      <h2
        id={`repo-settings-${section}-heading`}
        className="text-xl font-semibold"
      >
        {item.label}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
    </header>
  );
}

function ArchivedWorkspacesSection({
  owner,
  repo,
}: {
  owner: string;
  repo: string;
}) {
  const archived = useArchivedWorkspaces(owner, repo);
  const unarchive = useSetWorkspaceArchived(owner, repo);

  return (
    <section data-debug-component="ArchivedWorkspacesSection" className="mt-6">
      <h2 className="text-sm font-medium">Archived workspaces</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Archived workspaces stay registered and keep their Git branches and
        related issues and PRs.
      </p>
      {archived.isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : archived.error ? (
        <p className="mt-3 text-sm text-destructive">
          {String(archived.error)}
        </p>
      ) : archived.data?.length ? (
        <ul className="mt-3 max-w-md divide-y rounded-md border">
          {archived.data.map((workspace) => (
            <li
              key={workspace.branch}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="min-w-0 truncate text-sm">
                {workspace.branch}
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Unarchive ${workspace.branch}`}
                disabled={unarchive.isPending}
                onClick={() =>
                  unarchive.mutate({
                    branch: workspace.branch,
                    archived: false,
                  })
                }
              >
                {unarchive.isPending ? "Working…" : "Unarchive"}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted-foreground">
          No archived workspaces.
        </p>
      )}
      {unarchive.error ? (
        <p className="mt-2 text-sm text-destructive">
          {String(unarchive.error)}
        </p>
      ) : null}
    </section>
  );
}

// #485: rename the repo's owner/name. Worktree/dev-lock paths derive from the name, so the
// server refuses while worktrees exist under the current name — that error is surfaced here.
// On success, navigate to the renamed repo's new settings URL (the old /r/:owner/:repo/settings
// no longer resolves). Submit is gated on `loaded` (repo record confirmed to exist) — the old
// overflow-menu trigger was disabled the same way until useRepo resolved.
function RenameSection({
  owner,
  repo,
  loaded,
}: {
  owner: string;
  repo: string;
  loaded: boolean;
}) {
  const navigate = useNavigate();
  const rename = useRenameRepo(owner, repo);
  const [value, setValue] = useState(`${owner}/${repo}`);

  const unchanged = value.trim() === `${owner}/${repo}`;

  async function onSubmit() {
    let updated: Awaited<ReturnType<typeof rename.mutateAsync>>;
    try {
      updated = await rename.mutateAsync(value.trim());
    } catch {
      // Surfaced via rename.error below.
      return;
    }
    const [newOwner, newRepo] = updated.full_name.split("/");
    navigate({
      to: "/r/$owner/$repo/settings",
      params: { owner: newOwner, repo: newRepo },
    });
  }

  return (
    <section data-debug-component="RenameSection" className="mt-6">
      <h2 className="text-sm font-medium">Rename</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Changes the repository's owner/name in LoopHub. The local git folder is
        not moved. Renaming is refused while worktrees exist under the current
        name.
      </p>
      <form
        className="mt-3 flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!unchanged && !rename.isPending) onSubmit();
        }}
      >
        <input
          type="text"
          aria-label="New repository name"
          className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button
          type="submit"
          disabled={!loaded || rename.isPending || unchanged}
        >
          {rename.isPending ? "Working…" : "Rename"}
        </Button>
      </form>
      {rename.error ? (
        <p className="mt-2 text-sm text-destructive">{String(rename.error)}</p>
      ) : null}
    </section>
  );
}

// #1115: change the repo's base branch (default_branch). `default_branch` is auto-detected at
// `lh repo add` time and can end up wrong when the repo has no remote / origin/HEAD (it sticks to
// whatever branch was checked out at add time); this lets a human fix it afterwards. The backend
// (repos/update) verifies the branch exists and returns 422 "branch not found" otherwise — surfaced
// here. Save is gated on `loaded` plus a non-empty, changed value (mirrors the backend's own guards).
function BaseBranchSection({
  owner,
  repo,
  loaded,
  current,
}: {
  owner: string;
  repo: string;
  loaded: boolean;
  current: string;
}) {
  const setDefaultBranch = useSetRepoDefaultBranch(owner, repo);
  const [value, setValue] = useState(current);
  // The `current` we last seeded into the input, so the effect can tell a pristine input (still
  // equal to what we seeded) from one the user has edited.
  const seeded = useRef(current);

  // `current` is only known after the repo query resolves, and it changes when default_branch is
  // updated — here, or out-of-band (another session / the `lh` CLI) which also invalidates the repo
  // query. Reseed from it only while the input is still pristine, so an out-of-band change can't
  // overwrite an edit the user is in the middle of.
  useEffect(() => {
    const prevSeeded = seeded.current;
    seeded.current = current;
    setValue((prev) => (prev === prevSeeded ? current : prev));
  }, [current]);

  const trimmed = value.trim();
  const unchanged = trimmed === current;
  const canSubmit =
    loaded && !setDefaultBranch.isPending && trimmed !== "" && !unchanged;

  function onSubmit() {
    setDefaultBranch.mutate(trimmed, {
      // Failure is surfaced via setDefaultBranch.error below; swallow the rejection.
      onError: () => {},
    });
  }

  return (
    <section data-debug-component="BaseBranchSection" className="mt-6">
      <h2 className="text-sm font-medium">Base branch</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        The default branch new PRs target and the issue list groups by. Must be
        an existing branch in the local repository.
      </p>
      <form
        className="mt-3 flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit();
        }}
      >
        <input
          type="text"
          aria-label="Base branch"
          className="flex-1 rounded-md border bg-background px-3 py-1.5 text-sm"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <Button type="submit" disabled={!canSubmit}>
          {setDefaultBranch.isPending ? "Working…" : "Save"}
        </Button>
      </form>
      {setDefaultBranch.error ? (
        <p className="mt-2 text-sm text-destructive">
          {String(setDefaultBranch.error)}
        </p>
      ) : null}
    </section>
  );
}

// #406: per-repo PR write-action toggle. The repo offers exactly one of the internal Merge button
// or "Create PR on GitHub" on every PR detail; this picks which. "Auto" clears the override so the
// choice follows whether the repo has a GitHub remote (the effective default is shown inline).
function MergeModeSection({ owner, repo }: { owner: string; repo: string }) {
  const { data, isLoading } = useRepoMergeMode(owner, repo);
  const setMode = useSetRepoMergeMode(owner, repo);

  const current = data?.setting ?? null; // null = Auto
  const autoHint = data
    ? `follows remote — ${MERGE_MODE_LABELS[data.effective]}`
    : "";

  const options: { value: "auto" | MergeMode; label: string; hint?: string }[] =
    [
      { value: "auto", label: "Auto", hint: autoHint },
      { value: "merge", label: MERGE_MODE_LABELS.merge },
      { value: "github_pr", label: MERGE_MODE_LABELS.github_pr },
    ];

  return (
    <section data-debug-component="MergeModeSection" className="mt-6">
      <h2 className="text-sm font-medium">PR action</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Which write action the PR detail screen offers: the internal Merge
        button or "Create PR on GitHub".
      </p>
      <div
        role="radiogroup"
        aria-label="PR action"
        className="mt-3 max-w-md rounded-md border"
      >
        {options.map((o) => {
          const active = (current ?? "auto") === o.value;
          return (
            <button
              key={o.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={isLoading || setMode.isPending}
              className={cn(
                "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                disabledButtonStateClasses,
              )}
              onClick={() => {
                if (active) return;
                setMode.mutate(o.value);
              }}
            >
              <Check
                className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                aria-hidden="true"
              />
              <span className="flex flex-col">
                <span>{o.label}</span>
                {o.hint ? (
                  <span className="text-xs text-muted-foreground">
                    {o.hint}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {setMode.error ? (
        <p className="mt-2 text-sm text-destructive">{String(setMode.error)}</p>
      ) : null}
    </section>
  );
}

// #1532: per-repo Coding agent override. The toggle picks whether this repo pins its own runtime /
// model / effort or falls back to the application (Settings screen) defaults. While off, the editors
// are hidden and the effective config the run launches with is shown inline. Mirrors the raw-setting
// vs effective structure of MergeModeSection.
const OVERRIDE_LABELS: { value: boolean; label: string }[] = [
  { value: false, label: "Off (use application settings)" },
  { value: true, label: "On (override for this repo)" },
];

// An empty string means "use the runtime's default", stored as null. A currently-saved value outside
// the suggestion list is injected as a leading option so the picker reflects the real saved state.
function OverrideSelect({
  label,
  value,
  suggestions,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  suggestions: string[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const options =
    value && !suggestions.includes(value)
      ? [value, ...suggestions]
      : suggestions;
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <select
        aria-label={label}
        className="rounded-md border bg-background px-3 py-1.5 text-sm disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Default</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function AgentConfigSection({ owner, repo }: { owner: string; repo: string }) {
  const { data, isLoading } = useRepoAgentConfig(owner, repo);
  const save = useSetRepoAgentConfig(owner, repo);

  const setting = data?.setting;
  const override = setting?.override ?? false;
  // While editing, base the model/effort lists on the stored override runtime, else the effective
  // runtime so the suggestions match what a save would default to.
  const runtime: CodingAgent =
    setting?.runtime ?? data?.effective.runtime ?? "claude-code";
  const model = setting?.model ?? "";
  const effort = setting?.effort ?? "";
  const disabled = isLoading || save.isPending;

  // Persist the full triple on every edit so a single change never wipes the other stored values.
  function update(patch: {
    override?: boolean;
    runtime?: CodingAgent;
    model?: string;
    effort?: string;
  }) {
    save.mutate({
      override: patch.override ?? override,
      runtime: patch.runtime ?? runtime,
      model: patch.model ?? model,
      effort: patch.effort ?? effort,
    });
  }

  const effective = data?.effective;
  const effectiveHint = effective
    ? `${effective.runtime} · ${effective.model} · ${effective.effort}`
    : "";

  return (
    <section data-debug-component="AgentConfigSection" className="mt-6">
      <h2 className="text-sm font-medium">Coding agent</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Override the application's Coding agent settings (runtime, model,
        effort) for this repository's workflow runs. When off, runs use the
        application Settings defaults.
      </p>
      <div
        role="radiogroup"
        aria-label="Override application Coding agent settings"
        className="mt-3 max-w-md rounded-md border"
      >
        {OVERRIDE_LABELS.map((o) => {
          const active = override === o.value;
          return (
            <button
              key={String(o.value)}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              className={cn(
                "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                disabledButtonStateClasses,
              )}
              onClick={() => {
                if (active) return;
                update({ override: o.value });
              }}
            >
              <Check
                className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                aria-hidden="true"
              />
              <span className="flex flex-col">
                <span>{o.label}</span>
                {/* The hint describes the *current* effective config, so it belongs under whichever
                    option is active: the application defaults while off, the override while on. */}
                {active && effectiveHint ? (
                  <span className="text-xs text-muted-foreground">
                    effective — {effectiveHint}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>

      {override ? (
        <div className="mt-3 max-w-md border-l-2 pl-4">
          <h3 className="text-xs font-medium text-muted-foreground">Runtime</h3>
          <div
            role="radiogroup"
            aria-label="Runtime"
            className="mt-1 rounded-md border"
          >
            {CODING_AGENTS.map((value) => {
              const active = runtime === value;
              return (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={disabled}
                  className={cn(
                    "flex w-full items-start gap-2 border-b px-3 py-2 text-left text-sm last:border-b-0 hover:bg-accent hover:text-accent-foreground",
                    disabledButtonStateClasses,
                  )}
                  onClick={() => {
                    if (active) return;
                    // Switching runtime clears model/effort so they fall back to the new runtime's
                    // defaults rather than carrying a value that runtime may not accept.
                    update({ runtime: value, model: "", effort: "" });
                  }}
                >
                  <Check
                    className={`mt-0.5 size-4 shrink-0 ${active ? "" : "invisible"}`}
                    aria-hidden="true"
                  />
                  <span>{CODING_AGENT_LABELS[value]}</span>
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex flex-col gap-3">
            <OverrideSelect
              label="Model"
              value={model}
              suggestions={MODEL_SUGGESTIONS[runtime]}
              disabled={disabled}
              onChange={(value) => update({ model: value })}
            />
            <OverrideSelect
              label="Effort"
              value={effort}
              suggestions={EFFORT_SUGGESTIONS[runtime]}
              disabled={disabled}
              onChange={(value) => update({ effort: value })}
            />
          </div>
        </div>
      ) : null}
      {save.error ? (
        <p className="mt-2 text-sm text-destructive">{String(save.error)}</p>
      ) : null}
    </section>
  );
}

function ArchiveSection({
  owner,
  repo,
  loaded,
  archived,
}: {
  owner: string;
  repo: string;
  loaded: boolean;
  archived: boolean;
}) {
  const navigate = useNavigate();
  const setArchived = useSetRepoArchived(owner, repo);
  const [confirming, setConfirming] = useState(false);
  const action = archived ? "Unarchive" : "Archive";

  async function onConfirm() {
    try {
      await setArchived.mutateAsync(!archived);
    } catch {
      // Failure is surfaced via setArchived.error in the dialog; keep it open
      // and avoid an unhandled rejection from this event handler.
      return;
    }
    setConfirming(false);
    // Archiving removes the repo from active app-shell repo navigation; send the user
    // back home so they aren't left on a now-archived settings screen.
    if (!archived) navigate({ to: "/" });
  }

  return (
    <section data-debug-component="ArchiveSection" className="mt-6">
      <h2 className="text-sm font-medium">{action}</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {archived
          ? "Unarchiving this repository makes it appear in app navigation again."
          : "Archiving removes this repository from app navigation. You can unarchive it anytime."}
      </p>
      <Button
        className="mt-3"
        variant="secondary"
        disabled={!loaded}
        onClick={() => setConfirming(true)}
      >
        {action}
      </Button>

      {confirming ? (
        <ConfirmArchiveDialog
          owner={owner}
          repo={repo}
          archived={archived}
          pending={setArchived.isPending}
          error={setArchived.error ? String(setArchived.error) : null}
          onConfirm={onConfirm}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </section>
  );
}

function ConfirmArchiveDialog({
  owner,
  repo,
  archived,
  pending,
  error,
  onConfirm,
  onCancel,
}: {
  owner: string;
  repo: string;
  archived: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const action = archived ? "Unarchive" : "Archive";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[6vh]"
      onClick={onCancel}
    >
      <div
        data-debug-component="ConfirmArchiveDialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${action} repository`}
        className="flex w-full max-w-md flex-col rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">
          {action} {owner}/{repo}?
        </h2>
        <p className="mt-3 text-sm text-muted-foreground">
          {archived
            ? "Unarchiving this repository makes it appear in app navigation again."
            : "Archiving removes this repository from app navigation. You can unarchive it anytime."}
        </p>
        {error ? (
          <p className="mt-3 text-sm text-destructive">{error}</p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={onConfirm} disabled={pending}>
            {pending ? "Working…" : action}
          </Button>
        </div>
      </div>
    </div>
  );
}
