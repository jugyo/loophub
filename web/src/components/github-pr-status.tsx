// GitHub PR status section for the PR-detail right sidebar (#850). Shown only when the loophub PR has
// a linked GitHub PR (github_pull); the GitHub-side status (review / checks / comment counts /
// merged) is fetched on demand via `pulls/githubStatus` and cached server-side. Compact by design so
// it sits alongside the other sidebar sections (work duration, sessions, handoff) without crowding
// them — a badge row plus a few small labeled rows and a freshness footnote. The section body opens
// with the link out to the GitHub PR (#2091), so the GitHub route lives where the status is read;
// the heading itself is plain text. The section also owns the link's write actions — pushing the
// local head to its branch (#848, moved here in #2516) and unlinking it (#2384) — for the same
// reason: the link is managed where it is shown.
//
// Loading / error states mirror the sibling sidebar sections (e.g. WorkDuration): a spinner while
// fetching and a destructive box on failure. The "not linked" state renders nothing at all, so the
// sidebar can hand the section every PR and let it decide (like WorkflowRunSection).

import {
  ChevronDown,
  ExternalLink,
  Github,
  Loader2,
  Unlink,
  UploadCloud,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { GithubPrStatus, GithubPull, PullRequest } from "@/api/types";
import { useToast } from "@/components/toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { BadgeTone } from "@/lib/badges";
import { errorMessage } from "@/lib/error-message";
import { relativeTime } from "@/lib/time";
import { useBackdropDismiss } from "@/lib/use-backdrop-dismiss";
import { usePushGithubPull, useUnlinkGithubPull } from "@/queries/pulls";

const STATE: Record<
  GithubPrStatus["state"],
  { tone: BadgeTone; label: string }
> = {
  open: { tone: "open", label: "Open" },
  closed: { tone: "closed", label: "Closed" },
  merged: { tone: "merged", label: "Merged" },
};

const REVIEW: Record<
  NonNullable<GithubPrStatus["review_decision"]>,
  { tone: BadgeTone; label: string }
> = {
  approved: { tone: "review-passed", label: "Approved" },
  changes_requested: { tone: "review-changes", label: "Changes requested" },
  review_required: { tone: "review-rereview", label: "Review required" },
};

const CHECKS: Record<
  GithubPrStatus["checks"],
  { tone: BadgeTone; label: string } | null
> = {
  success: { tone: "review-passed", label: "Passed" },
  failure: { tone: "conflict", label: "Failing" },
  pending: { tone: "working", label: "Pending" },
  // No checks configured on the GitHub PR — the row is hidden rather than showing a meaningless badge.
  none: null,
};

const MERGEABLE: Record<
  GithubPrStatus["mergeable"],
  { tone: BadgeTone; label: string } | null
> = {
  mergeable: { tone: "mergeable", label: "No conflicts" },
  conflicting: { tone: "conflict", label: "Conflicts" },
  // Unknown (e.g. a merged/closed PR, or GitHub still computing) — hidden to keep the panel compact.
  unknown: null,
};

/**
 * The GitHub PR link's text: the stored URL minus its scheme and host, e.g. `me/proj/pull/42`. Kept
 * as a plain strip rather than a parse into owner/repo/number, so a URL that doesn't have the shape
 * we expect still reads as itself instead of throwing or being reduced to a bare number.
 */
function githubPrPath(url: string) {
  return url.replace(/^https?:\/\/[^/]+\//, "");
}

/** One `label + badge` row; renders nothing when the badge is absent (keeps the panel compact). */
function StatusRow({
  label,
  badge,
}: {
  label: string;
  badge: { tone: BadgeTone; label: string } | null;
}) {
  if (!badge) return null;
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Badge tone={badge.tone}>{badge.label}</Badge>
    </div>
  );
}

export function GithubPrStatusSection({
  owner,
  repo,
  pull,
  status,
  isLoading,
}: {
  // The loophub PR the section belongs to: its coordinates address the section's mutations (#2384,
  // #2516), its link is what the section shows, and the push action reads its state/head to decide
  // whether there is anything to push.
  owner: string;
  repo: string;
  pull: PullRequest;
  status: GithubPrStatus | undefined;
  isLoading: boolean;
  // isError is intentionally not a prop: the section only renders for a linked GitHub PR (an enabled
  // query), so the states are exhaustive — loading, a status to show, or (no status, not loading) an
  // error. A failed background refetch keeps `status`, so it stays on the data branch. See the JSX.
}) {
  // The linked GitHub PR (#2035): the body's first row is the single link out to GitHub, so the
  // PR-detail action row doesn't need a separate "View PR on GitHub" button. Without a link there is
  // no status to read and nothing to push, so the whole section is absent.
  const githubPull = pull.github_pull;
  if (!githubPull) return null;
  return (
    <section
      data-debug-component="GithubPrStatusSection"
      className="flex flex-col gap-3"
    >
      <h2 className="text-lg font-semibold">GitHub PR</h2>
      {/* The route out to GitHub (#2091). Outside the status branches below because it is the PR
          detail's only link to the GitHub PR, so it must stay reachable while the status is loading
          or failed. The text is the URL's own `owner/repo/pull/N` path rather than a bare `#N`: it
          says which GitHub repo the PR lives in, which a fork or a mirror makes non-obvious. */}
      <a
        href={githubPull.url}
        target="_blank"
        rel="noopener noreferrer"
        title={`GitHub PR #${githubPull.number}`}
        className="inline-flex w-fit items-center gap-1.5 text-sm hover:underline"
      >
        <Github className="size-4 shrink-0" />
        <span className="min-w-0 break-all">
          {githubPrPath(githubPull.url)}
        </span>
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
      </a>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading GitHub status…
        </div>
      ) : /* Prefer the last-loaded status over the error box: React Query keeps `data` on a failed
            background refetch, so a transient blip (server restart, focus refetch) shouldn't blank a
            good panel. The error box shows only when there is no status to fall back to. */
      status ? (
        <div className="flex flex-col gap-2">
          {/* Top line: overall GitHub PR state. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={STATE[status.state].tone}>
              {STATE[status.state].label}
            </Badge>
          </div>
          <StatusRow
            label="Review"
            badge={
              status.review_decision
                ? REVIEW[status.review_decision]
                : { tone: "unknown", label: "None" }
            }
          />
          <StatusRow label="Checks" badge={CHECKS[status.checks]} />
          <StatusRow label="Mergeable" badge={MERGEABLE[status.mergeable]} />
          {/* Two distinct counts, labeled so neither is mistaken for the other (#850 AC): conversation
              comments vs submitted reviews. */}
          <p className="text-xs text-muted-foreground">
            {status.comments} comment{status.comments === 1 ? "" : "s"} ·{" "}
            {status.reviews} review{status.reviews === 1 ? "" : "s"}
          </p>
          <p className="text-xs text-muted-foreground">
            {status.updated_at
              ? `Updated ${relativeTime(status.updated_at)} · `
              : ""}
            synced {relativeTime(status.synced_at)}
          </p>
        </div>
      ) : (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          Failed to load GitHub status.
        </div>
      )}
      {/* Outside the status branches, like the link above: whether the local head is ahead of what
          was pushed is answered by the PR itself, so a slow or failed status must not hide the push
          (#2516); and unlinking is what you reach for when the link is wrong or its GitHub PR is
          gone, which is exactly when the status fails to load. */}
      <PushGithubPrAction
        owner={owner}
        repo={repo}
        pull={pull}
        githubPull={githubPull}
      />
      <UnlinkGithubPrAction
        owner={owner}
        repo={repo}
        number={pull.number}
        githubPull={githubPull}
      />
    </section>
  );
}

/**
 * Push action for the section (#2516): sends the PR's local head to the linked GitHub PR's branch
 * (#848), with the rewritten-head variant behind the dropdown (#1861). It sits with the link and the
 * status rather than in the PR-detail action row because pushing operates on the link this section
 * shows, leaving that row to the LoopHub-side write actions. `isPending` drives the disabled +
 * spinner state so the click can't fire twice, and a failed push surfaces as a toast — the mutation
 * has no dialog of its own to land in.
 */
function PushGithubPrAction({
  owner,
  repo,
  pull,
  githubPull,
}: {
  owner: string;
  repo: string;
  pull: PullRequest;
  githubPull: GithubPull;
}) {
  const { showError } = useToast();
  // The same mutation force-pushes when the dropdown's Force push is chosen — the button itself
  // always stays a plain push.
  const pushChanges = usePushGithubPull(owner, repo, pull.number);
  const push = (force: boolean) =>
    pushChanges.mutate(force, {
      onError: (e) =>
        showError(
          errorMessage(
            e,
            force ? "Force push to GitHub failed" : "Push to GitHub failed",
          ),
        ),
    });

  // Unpushed local changes exist when we know what was last pushed (pushed_sha) and the PR's head
  // has moved past it. Gated on an open, unmerged PR and a recorded branch to push onto — a
  // closed/merged PR is past syncing, and a null pushed_sha (e.g. an externally-attached PR never
  // pushed from here) reads as "nothing known to be unpushed", so the button stays disabled.
  const hasUnpushedChanges =
    pull.state === "open" &&
    !pull.merged &&
    !!githubPull.branch &&
    !!githubPull.pushed_sha &&
    !!pull.head.sha &&
    pull.head.sha !== githubPull.pushed_sha;

  return (
    <div className="inline-flex w-fit">
      <Button
        variant="secondary"
        size="sm"
        className="rounded-r-none"
        disabled={!hasUnpushedChanges || pushChanges.isPending}
        title={
          hasUnpushedChanges
            ? `Push local changes to the GitHub PR branch (${githubPull.branch})`
            : "No local changes to push to GitHub"
        }
        onClick={() => push(false)}
      >
        {pushChanges.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <UploadCloud className="size-4" />
        )}
        {pushChanges.isPending ? "Pushing…" : "Push to GitHub"}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="secondary"
            size="sm"
            aria-label="Push options"
            title="Push options"
            className="rounded-l-none border-l px-2"
            disabled={!hasUnpushedChanges || pushChanges.isPending}
          >
            <ChevronDown className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            title={`Force-push the head to the GitHub PR branch (${githubPull.branch}) with --force-with-lease, for a head rewritten by rebase or amend`}
            onSelect={() => push(true)}
          >
            <UploadCloud className="size-4" />
            Force push to GitHub
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * Unlink action for the section (#2384): drops the LoopHub-side link so a wrong link can be
 * corrected or a GitHub PR created again — the PR-detail action row returns to "Create PR on
 * GitHub" once `github_pull` is null. Destructive enough to confirm first, and the confirmation
 * says what is and is not affected, since "unlink" could otherwise be read as closing the GitHub PR.
 * The dialog follows the PR archive confirmation (pull-debug-menu.tsx): backdrop/Escape dismissal
 * gated on the in-flight request, and the mutation error shown in the dialog rather than a toast, so
 * the failure lands next to the action that caused it.
 */
function UnlinkGithubPrAction({
  owner,
  repo,
  number,
  githubPull,
}: {
  owner: string;
  repo: string;
  number: number;
  githubPull: GithubPull;
}) {
  const [confirming, setConfirming] = useState(false);
  const unlink = useUnlinkGithubPull(owner, repo, number);
  const backdropDismiss = useBackdropDismiss(() => {
    if (!unlink.isPending) setConfirming(false);
  });

  // Escape dismisses the dialog, under the same in-flight guard as the buttons and the backdrop.
  useEffect(() => {
    if (!confirming) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !unlink.isPending) setConfirming(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [confirming, unlink.isPending]);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="w-fit px-2 text-muted-foreground"
        title="Remove this PR's link to the GitHub PR (the GitHub PR itself is not changed)"
        onClick={() => setConfirming(true)}
      >
        <Unlink className="size-3.5" />
        Unlink GitHub PR
      </Button>
      {confirming ? (
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 pt-[12vh]"
          {...backdropDismiss}
        >
          <div
            data-debug-component="UnlinkGithubPrDialog"
            role="dialog"
            aria-modal="true"
            aria-label={`Unlink GitHub PR #${githubPull.number}?`}
            className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-lg font-semibold">
              Unlink GitHub PR #{githubPull.number}?
            </h2>
            <p className="mt-3 text-sm text-muted-foreground">
              This removes only this PR's link to {githubPrPath(githubPull.url)}{" "}
              in LoopHub. The pull request on GitHub is not closed or changed.
              Afterwards you can create a GitHub PR again from this PR.
            </p>
            {unlink.error ? (
              <p className="mt-3 text-sm text-destructive">
                {errorMessage(unlink.error, "Unlink failed")}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="secondary"
                disabled={unlink.isPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                disabled={unlink.isPending}
                onClick={() =>
                  unlink.mutate(undefined, {
                    onSuccess: () => setConfirming(false),
                  })
                }
              >
                {unlink.isPending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {unlink.isPending ? "Unlinking…" : "Unlink"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
