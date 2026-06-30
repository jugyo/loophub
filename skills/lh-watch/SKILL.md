---
name: lh-watch
description: >-
  Watch a LoopHub repo's events and auto-start ready work: for each open issue that looks ready to
  begin (unblocked, not already being worked), launch `lh dev --auto --kani <id>` in a kani terminal.
  You do the watching and the judgement; the dispatched session does the implementation. Use when the user
  runs /lh-watch, asks to monitor a repo and auto-start ready issues, watch events and dispatch, 監視,
  自動ディスパッチ, 着手可能タスクを自動で進める. Does not review or merge.
---

# LoopHub watch & dispatch

Watch this repo's events and keep work moving: when an issue becomes ready to start, launch a `lh dev`
session for it. **You (the agent) do the watching and the judgement — this skill is the policy, not a
shell program to run verbatim.** The implementation itself is done by the dispatched `lh dev --auto`
session, not here.

In one line: **monitor `lh events` for this repo, and for each issue that looks ready to start, run
`lh dev --auto --kani <id>` in a kani terminal (KaniFarm).**

## Scope

- **Every ready issue is auto-started** (treated as AFK). LoopHub has no AFK/HITL marker, so there is
  no "notify a human instead" branch — if an issue must not auto-start, leave it blocked or closed.
- **Only starts work.** Review, merge, and PR routing are owned by the dispatched `lh dev` session and
  the review chain — this skill does not review, merge, or move PRs.
- **Trusted authorship only.** A dispatched `lh dev --auto` session reads the issue body as its
  instructions, so anyone who can file or unblock an issue here can start an unattended session. Only
  run this on a repo whose issue authorship you trust.

## Target repo

Resolve the **main checkout root** and the **repo slug** once, then `cd` to the root so the cwd-scoped
commands work:

```sh
ROOT="$(git worktree list --porcelain | sed -n '1s/^worktree //p')"   # main checkout, even from a worktree
REPO="$(lh repo list --json | jq -r --arg p "$ROOT" '.[] | select(.local_path==$p) | .full_name')"
cd "$ROOT"
```

- `lh issue` and `lh dev` resolve the repo from cwd, but only against the **main checkout** path — from
  a linked worktree they fail. So `cd "$ROOT"` first; the Claude Code host persists the working
  directory across Bash calls, so later `lh issue` / `lh dev` calls still resolve correctly.
- **`lh events` is not cwd-scoped** — without `--repo` it returns every repo's events, so always pass the
  resolved slug. A shell `$REPO` does **not** survive into a later Bash call, so substitute the literal
  slug (or re-resolve it) where you tail the feed.
- `--repo owner/name` is otherwise an optional override (e.g. watching from an unrelated cwd).

## When is an issue ready to start?

Judge each open issue yourself — start it when all hold:

- **Not already being worked or done**: it has no linked PR that is open (in progress) or merged (done).
  A closed-unmerged PR is an abandoned attempt — still a candidate. `lh issue list --json` exposes the
  plural `linked_pull_requests`; check it for any open or merged entry (the singular
  `linked_pull_request` from `lh issue view` surfaces the open one but can hide a merged PR behind a
  later closed-unmerged one).
- **Unblocked**: any blockers in the issue body's `## Blocked by` section (written as `#n` references)
  are all closed. No such section, or `None`, means unblocked. Read the section yourself; ignore
  example refs that only appear inside HTML comments.
- **Not already started by you this run.**

When you can't tell whether something is a real blocker, treat the issue as blocked and don't start it
— that is the safe direction.

## Watch & dispatch

The live feed needs **`lh-web` running** (`lh events -f` tails the server's stream; if lh-web is down it
errors out).

1. **Initial pass.** List open issues (`lh issue list --json`) and start each one that is ready.
2. **Watch the event stream (primary).** Run the live feed **in the background** so it doesn't block
   you: `lh events -f --repo <slug> --json` (NDJSON, one event per line; substitute the resolved slug).
   Watching the stream is the point — react as things happen. Re-check open issues and start any
   now-ready ones when an event suggests readiness may have changed:
   - `issue.opened` — a newly filed issue may already be ready;
   - `issue.closed` / `pull_request.merged` — a blocker may have just been released.

   Ignore other event types.
3. **Periodic safety sweep (~every minute).** While watching, also re-apply the readiness checks
   (§ When is an issue ready to start?) over every open issue on a roughly one-minute cadence, even when
   no event fired. The stream stays the primary signal; this is a backstop that (a) catches readiness
   changes that produce no triggering event — e.g. a blocker edited out of an issue body — and
   (b) re-establishes the feed if it has died (don't treat a dead feed's silence as "nothing ready"),
   so nothing ready sits unstarted for more than about a minute.

**Dispatch** a ready issue by launching its dev loop in a kani terminal (KaniFarm), so this watcher
keeps running while the dev session works in parallel:

```sh
lh dev --auto --kani <id>
```

Re-checking on any event or sweep is safe even before a dispatched session opens its PR: your **"not
started by you this run"** memory skips it, and `lh dev` itself holds a host-local worktree lock plus a soft
one-open-PR-per-issue guard, so a stray second launch is rejected rather than duplicating work. (Once
the session opens its PR, the open-PR check also skips it.)

## Report

This skill persists no PR/issue text. Report status to the operator in the **conversation language**:
the repo being watched, issues started (number → title, with their dev terminal), and any skipped with
the reason (already being worked / still blocked). Commands and identifiers stay English.

## Prohibited

- Do not review, merge, or move PRs — only start `lh dev`.
- Do not start an issue that is already being worked (open/merged linked PR) or still blocked.
- Do not run a foreground `lh dev` from the watcher (it blocks the loop) — use a kani terminal.
