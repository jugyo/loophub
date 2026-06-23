# Canon — canonical reference docs ("聖典")

External documents that guide how we design and improve AI-agent-driven development loops in LoopHub. These are **summaries with attribution**, not full-text reproductions: each entry condenses an external source and links back to the original. Read the source for authoritative text.

## How to use this directory

- Treat these as *design north stars*, not specs. They inform decisions; they are not requirements.
- Applying their ideas to LoopHub code or skills is intentionally **out of scope** here — that happens in separate issues.
- When adding a new canon entry, follow the conventions below.

## Index

| Document | Source | When to reference |
|----------|--------|-------------------|
| [Codex-maxxing for long-running work](./codex-maxxing-for-long-running-work.md) | OpenAI white paper (PDF) | Designing the overall **loop** (durable context, memory, recurrence, steering, review surfaces); deciding what a session can touch; setting verifiable goals. |
| [Effective harnesses for long-running agents](./anthropic-effective-harnesses-for-long-running-agents.md) | Anthropic Engineering, 2025-11-26 | Designing how an agent makes progress **across many sessions/context windows**: worktree setup, progress files, feature lists, git-as-recovery, verify-before-build. |
| [Building effective agents](./anthropic-building-effective-agents.md) | Anthropic, 2024-12-19 | Choosing an **architecture pattern** (workflow vs. agent; chaining, routing, parallelization, orchestrator–workers, evaluator–optimizer); tool design; keeping it simple. |

## Conventions for new entries

Each canon document must include, near the top:

- **Source title** and **publisher**
- **Source URL** (the original)
- **Retrieved** date (acquisition date, `YYYY-MM-DD`)
- A note that it is a summary, not a reproduction (avoid licensed full-text reproduction — summarize and link)
- A short **"Why this matters to LoopHub"** section so the relevance is explicit

Add the new file to the index table above with a one-line "when to reference".
