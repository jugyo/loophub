# Effective harnesses for long-running agents (Anthropic)

> **Canonical reference — summary + attribution.** Condensed, paraphrased
> summary for internal guidance, not a reproduction of the original.

- **Source title**: *Effective harnesses for long-running agents*
- **Publisher**: Anthropic (Engineering blog)
- **Published**: 2025-11-26
- **Source URL**: <https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>
- **Retrieved**: 2026-06-23

## Why this matters to LoopHub

This is the closest Anthropic-side parallel to the Codex-maxxing paper, and it is almost a blueprint for LoopHub's reason to exist: an agent must make consistent progress *across many context windows*, where "each new session begins with no memory of what came before." The two-phase (initializer + coding) architecture, the feature-list-as-source-of-truth, and git-as-recovery map directly onto LoopHub's worktree + issue/PR loop.

## Core thesis

Long-running agents struggle to maintain context and make consistent progress across sessions. Borrowing from human software-engineering practice, a two-part harness — an **initializer agent** and a **coding agent** — lets the model work effectively across many context windows. Standard context compaction alone is insufficient.

## The long-running agent problem

- Agents attempt too much at once and exhaust context mid-implementation.
- Later sessions prematurely declare the project "done" without full functionality.
- Sessions need a way to *bridge the gap* — to get up to speed on prior work.

## Two-part architecture

- **Initializer agent (first session only)** — sets up the environment: an `init.sh` to launch the dev server, a `claude-progress.txt` work log, an initial git repo with a baseline commit, and a **feature-list file**.
- **Coding agent (every later session)** — works one feature at a time, leaves clean mergeable code, updates the progress file and git history, and runs verification tests before starting new work.

## Key components

- **Feature list file** — comprehensive JSON requirements (200+ features in the claude.ai-clone example), all initially marked failing. Agents edit only the `passes` field, never the requirements themselves ("It is unacceptable to remove or edit tests").
- **Incremental progress** — at most one feature per session; descriptive git commits; progress-file summaries. Enables reverting broken changes and recovering working states.
- **Testing framework** — end-to-end tests that mimic a real user (browser automation, e.g. a Puppeteer MCP for web apps). Catches bugs invisible to code review and prevents marking incomplete features done.

## "Getting up to speed" protocol (every session)

1. Verify the working directory.
2. Review git logs and the progress file.
3. Consult the feature list for the highest-priority incomplete feature.
4. Start the dev server via `init.sh`.
5. Run a basic end-to-end functionality test.
6. Begin the targeted feature implementation.

## Concrete recommendations

- Maintain three persistent cross-session files: feature list (JSON), progress tracker (text), init script (shell).
- Hand off with **structured updates** — git commits + progress docs.
- Prompt agents to test as end-users, not just verify syntax.
- Enforce constraints against editing the core requirement/test files.
- Verify existing functionality *before* implementing new features.
- Use git history as both documentation and recovery mechanism.

## Open questions raised

Whether to specialize agents (testing / QA / cleanup agents) vs. one general-purpose agent, and how far the pattern generalizes beyond web dev (scientific research, financial modeling).
