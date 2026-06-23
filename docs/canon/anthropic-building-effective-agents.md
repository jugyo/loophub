# Building effective agents (Anthropic)

> **Canonical reference — summary + attribution.** Condensed, paraphrased
> summary for internal guidance, not a reproduction of the original.

- **Source title**: *Building effective agents*
- **Publisher**: Anthropic (Research / Engineering)
- **Published**: 2024-12-19
- **Source URL**: <https://www.anthropic.com/research/building-effective-agents>
- **Retrieved**: 2026-06-23

## Why this matters to LoopHub

This is the foundational vocabulary for *how* an agent system should be put together. It supplies the workflow/agent distinction and the small set of composable patterns that any LoopHub runner or dev-loop design should reach for before inventing bespoke orchestration. Its central advice — "do the simplest thing that works" — is the right default for LoopHub's own architecture.

## Core thesis

The most successful agent implementations use simple, composable patterns rather than intricate frameworks. Start simple; add complexity only when it demonstrably improves outcomes. If you use a framework, understand what it does underneath.

## Key distinction: workflows vs. agents

- **Workflows** — LLMs and tools orchestrated through *predefined code paths*.
- **Agents** — LLMs *dynamically direct* their own processes and tool usage, staying in control of how they accomplish the task.

## Building block

- **Augmented LLM** — the foundation: an LLM enhanced with retrieval, tools, and memory.

## Workflow patterns

1. **Prompt chaining** — decompose a task into sequential steps with intermediate validation gates.
2. **Routing** — classify the input and direct it to a specialized downstream path.
3. **Parallelization** — run independent subtasks at once (sectioning) or run the same task multiple times for diverse outputs (voting).
4. **Orchestrator–workers** — a central LLM dynamically delegates unpredictable subtasks to worker LLMs.
5. **Evaluator–optimizer** — one LLM generates, another critiques, looping until the result is good enough.

## Agent pattern

- **Autonomous agents** — operate independently in an environment-feedback loop, executing an unpredictable number of steps until done (or a stop condition).

## Key recommendations

- Prioritize **simplicity**; expand complexity only when justified.
- Maintain **transparency** — show the agent's planning steps.
- Invest in **tool documentation and testing**; treat the agent–computer interface with the same rigor as a user interface. Bloated/ambiguous toolsets are a top failure mode — if a human can't say which tool to use, neither can the agent.
- Test extensively in **sandboxed environments** with guardrails.
- Measure performance and iterate rather than reaching for premature complexity.
