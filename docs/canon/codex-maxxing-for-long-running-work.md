# Codex-maxxing for long-running work

> **Canonical reference — summary + attribution.** This is a condensed,
> paraphrased summary for internal guidance, not a reproduction of the original.
> Read the source for the authoritative text.

- **Source title**: *Codex-maxxing for long-running work — How Codex helps work continue beyond a single prompt* (OpenAI white paper)
- **Publisher**: OpenAI
- **Featured practitioner**: Jason Liu (the workflows described are drawn from his everyday Codex use)
- **Source URL**: <https://cdn.openai.com/pdf/8a9f00cf-d379-4e20-b06f-dd7ba5196a11/OAI_WhitePaper_Codex-maxxing26.pdf>
- **Retrieved**: 2026-06-23
- **Format note**: original is a PDF; summarized to Markdown here (no full-text reproduction, per licensing).

## Why this matters to LoopHub

LoopHub exists so AI agents can run development loops while a human supervises with minimal attention. This paper is the clearest external articulation of the same idea from OpenAI's side: giving long-running work *somewhere to live* — durable context, memory, tools, recurrence, and a review surface — so work continues across more than one prompt. The "loop = context + tools + memory + recurrence + review" framing maps directly onto LoopHub's issue/PR + persisted-event model.

## Core thesis

Codex is built for coding (diffs, repos, reviews, shipping), but the broader shift is that it gives *work somewhere to live*. When a session has a durable thread, shared memory, tool access, a way to recur, and a place to review its own output, the work keeps moving beyond a single prompt — for non-developer workstreams too.

## The ten elements (section by section)

1. **Durable threads** — A pinned thread becomes the home for a workstream: context, preferences, past decisions, and open loops accumulate over time. Tradeoff: long threads carry context and cost more than a fresh short thread; for important workstreams continuity is worth it.
2. **Voice input** — Spoken input captures the *unedited* version of your thinking (the half-remembered name, the loose direction, the uncertainty). Plans get better when the model has the messy version of what you think.
3. **Steering** — Add the next instruction *while the agent is already working*: correct direction, add context, approve the next step, or queue the next action ("Once this is done, open a PR." / "Show me the preview link before anything is posted.").
4. **Memory** — Memory is a reviewable notebook outside the conversation. One pattern is a **vault** (`vault/` with `TODO.md`, `people/`, `projects/`, `agent/`, `notes/`). Keep the distinction: **repositories hold code; the vault holds the rolling context around the work.** When the vault lives in GitHub, diffs become a review surface for memory — you see what the agent thought was important enough to write down. Record what *changed* (decisions, closed loops, preferences), not vague impressions.
5. **Computer and browser use** — Decide what a thread can touch. Separate the surfaces: `$browser` (local previews/annotations), `@chrome` (signed-in sessions, authenticated tabs), `@computer` (GUI-only clicking), connectors (Slack/Gmail/Calendar/GitHub), and skills (reusable workflows). Match the surface to the task; use the most constrained one that works.
6. **Remote control** — Keep long loops portable. The agent keeps working where your files, permissions, and local setup live; you check in from another device to review, answer, approve, or redirect. Not a reason to skip reviews — a way to keep enough attention to unblock the next move.
7. **Thread automations** — Heartbeat-style recurring wake-ups attached to the current thread, preserving context instead of restarting. "Do this now" (normal prompt) vs. "Keep checking this and move it forward when something changes" (automation). A thread can have multiple schedules and run until a condition is met.
8. **Three examples of loops** — (1) *Chief of Staff*: scan Slack/Gmail on a schedule, find messages, gather context, draft replies; the human decides what's sent. (2) *Monitor for feedback*: watch a Slack thread, update a Remotion project, re-render, prep the revision. (3) *Get a refund*: check whether a support agent joined, prep the next response; action stays bounded and irreversible steps need consent.
9. **Goals** — Set goals the agent can *verify*. Weak: "Implement the plan in this Markdown file." Strong: "Port this library, keep the public API compatible, use the original unit tests as the success check; ready for review when the same tests pass and the differences are documented." The Rich-to-Rust port is the worked example — the original test suite is the standard.
10. **Side panel** — Make the artifact part of the loop. The side panel is a shared object you and the agent both inspect (Markdown, spreadsheets, CSVs, PDFs, slides, `index.html`, Storybook, Streamlit, Jupyter). Comments become instructions; the artifact becomes context. It's where the tool stops being a chat app and becomes the place the work happens.

## Takeaways worth stealing

- The **loop** is the unit of value: context + tools + memory + recurrence + review, not any single feature.
- **Memory must be reviewable** (open, edit, diff, reuse) — keep code and rolling context separate.
- **Verifiable goals** beat plans: give the agent a success check (tests, review criteria, definition of done).
- **Human stays on irreversible actions** — automations prepare, humans approve.
