import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RelatedSession } from "@/api/types";

import { RelatedSessions, TokenUsageSummary } from "./related-sessions";

afterEach(() => {
  cleanup();
});

function session(over: Partial<RelatedSession>): RelatedSession {
  return {
    id: "id",
    agent: "lh-build",
    session: "ext",
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    linked_at: "2026-06-01T00:00:00Z",
    resume: { resumable: false },
    ...over,
  };
}

// The expand toggle is the row button carrying aria-expanded (distinct from Resume / copy buttons).
function toggles(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button[aria-expanded]"),
  );
}

function resumeButtons(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(
    container.querySelectorAll<HTMLButtonElement>("button"),
  ).filter((b) => b.textContent?.includes("Resume"));
}

describe("RelatedSessions", () => {
  it("renders nothing when there are no sessions", () => {
    const { container } = render(
      <RelatedSessions owner="jugyo" repo="loophub" sessions={[]} />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders no Resume buttons and keeps old anchor reason text hidden (#401, #632)", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        pullNumber={7}
        cwd="/home/me/.loophub/worktrees/jugyo/loophub/issue-7"
        sessions={[
          session({
            id: "a",
            kind: "dev",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
          // Formerly the "superseded" anchor reason — now treated identically to any other session.
          session({
            id: "b",
            kind: "dev",
            session: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            resume: { resumable: false, reason: "superseded" },
          }),
        ]}
      />,
    );
    expect(resumeButtons(container).length).toBe(0);
    // The old muted anchor reasons are gone entirely.
    expect(container.textContent).not.toContain(
      "superseded by a newer dev session",
    );
    expect(container.textContent).not.toContain("not this PR's resume target");
    expect(container.textContent).toContain("Sessions");
  });

  it("uses `lh resume <owner>/<repo>/<pr>` for the PR dev anchor copy command", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        pullNumber={7}
        cwd="/home/me/.loophub/worktrees/jugyo/loophub/issue-7"
        sessions={[
          session({
            id: "a",
            kind: "dev",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(within(li).getByRole("button", { expanded: false }));

    expect(li.textContent).toContain("lh resume jugyo/loophub/7");
    expect(li.textContent).not.toContain("claude --resume");
    fireEvent.click(
      within(li).getByRole("button", { name: "Copy resume command" }),
    );
    expect(writeText).toHaveBeenCalledWith("lh resume jugyo/loophub/7");
  });

  it("quotes the PR resume target and omits the direct-Claude directory hint", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo; touch /tmp/pwned"
        repo="loop hub"
        pullNumber={7}
        sessions={[
          session({
            id: "a",
            kind: "dev",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(within(li).getByRole("button", { expanded: false }));

    expect(li.textContent).toContain(
      "lh resume 'jugyo; touch /tmp/pwned/loop hub/7'",
    );
    expect(li.textContent).not.toContain("working directory");
  });

  it("on issue detail (no cwd): issue-create and worktree-less sessions keep direct copyable commands (#566, #632)", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        sessions={[
          session({
            id: "ic",
            kind: "issue-create",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
          session({
            id: "r",
            kind: "review",
            session: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            resume: { resumable: false, reason: "resume-via-pull" },
          }),
        ]}
      />,
    );
    expect(resumeButtons(container).length).toBe(0);
    expect(container.textContent).not.toContain("resume from the linked PR");
    const issueCreateLi = container.querySelectorAll("li")[0] as HTMLElement;
    fireEvent.click(
      within(issueCreateLi).getByRole("button", { expanded: false }),
    );
    expect(issueCreateLi.textContent).toContain(
      "claude --resume 11111111-2222-3333-4444-555555555555",
    );
    const reviewLi = container.querySelectorAll("li")[1] as HTMLElement;
    fireEvent.click(within(reviewLi).getByRole("button", { expanded: false }));
    expect(reviewLi.textContent).toContain(
      "claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
    expect(reviewLi.textContent).toContain("working directory");
  });

  it("joins cwd into `cd <path> && claude --resume <id>` and copies the whole command (#345)", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        cwd="/home/me/.loophub/worktrees/jugyo/loophub/issue-7"
        sessions={[
          session({
            id: "a",
            kind: "dev",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    // Collapsed by default: command hidden.
    expect(li.textContent).not.toContain("claude --resume");
    fireEvent.click(within(li).getByRole("button", { expanded: false }));
    const joined =
      "cd /home/me/.loophub/worktrees/jugyo/loophub/issue-7 && \\\n  claude --resume 11111111-2222-3333-4444-555555555555";
    // The displayed command block is the joined form, split with a `\` line-continuation (path
    // needs no shell quoting).
    expect(li.textContent).toContain(joined);
    // Its copy button copies the whole joined command in one shot.
    fireEvent.click(
      within(li).getByRole("button", { name: "Copy resume command" }),
    );
    expect(writeText).toHaveBeenCalledWith(joined);
    // No separate "Run in:" path row — the path lives in the joined command now.
    expect(li.textContent).not.toContain("Run in:");
    // The inline launch button is gone; only the copy button remains.
    expect(resumeButtons(li).length).toBe(0);
  });

  it("falls back to the bare `claude --resume <id>` plus a directory hint when cwd is unknown (#345)", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        sessions={[
          session({
            id: "a",
            kind: "issue-create",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    // No cwd → no `cd` prefix in the copyable command, just the bare command.
    expect(li.textContent).toContain(
      "claude --resume 11111111-2222-3333-4444-555555555555",
    );
    expect(li.textContent).not.toContain("cd ");
    // Prose hint about where to run it (the directory guidance fallback).
    expect(li.textContent).toContain("working directory");
  });

  it("shell-quotes a cwd that contains spaces in the joined command (#345)", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        cwd="/home/me/My Worktrees/issue-7"
        sessions={[
          session({
            id: "a",
            kind: "dev",
            session: "11111111-2222-3333-4444-555555555555",
            resume: { resumable: true },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    expect(li.textContent).toContain(
      "cd '/home/me/My Worktrees/issue-7' && \\\n  claude --resume 11111111-2222-3333-4444-555555555555",
    );
  });

  it("shell-quotes the resume id too, so a non-UUID id cannot inject tokens (#345)", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        cwd="/home/me/.loophub/worktrees/jugyo/loophub/issue-7"
        sessions={[
          session({
            id: "a",
            kind: "dev",
            // Defense in depth: ids are UUIDs in practice, but the component must not assume it.
            session: "x; rm -rf ~",
            resume: { resumable: true },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    expect(li.textContent).toContain("claude --resume 'x; rm -rf ~'");
  });

  it("shows the reason instead of a command when the runtime has no claude session", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        cwd="/home/me/.loophub/worktrees/jugyo/loophub/issue-7"
        sessions={[
          session({
            id: "c",
            kind: "review",
            resume: { resumable: false, reason: "no-session" },
          }),
        ]}
      />,
    );
    // A session with no claude id cannot be launched in the terminal — no Resume button.
    expect(resumeButtons(container).length).toBe(0);
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    expect(li.textContent).not.toContain("claude --resume");
    expect(li.textContent).toContain("Cannot resume from a terminal");
    // The reason is shown without the old redundant "not resumable: not resumable" doubling.
    expect(li.textContent).not.toContain("Not resumable: not resumable");
  });

  it("keeps PR category usage collapsed until details are opened", () => {
    const { container, getByRole } = render(
      <TokenUsageSummary
        usage={{
          sessions_with_usage: 2,
          input_tokens: 105,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 15,
          total_tokens: 170,
          cost_usd: null,
          has_unknown_cost: true,
          context_usage_percent: 72.4,
          by_kind: [
            {
              kind: "dev",
              sessions_with_usage: 1,
              input_tokens: 100,
              cache_creation_input_tokens: 20,
              cache_read_input_tokens: 30,
              output_tokens: 10,
              total_tokens: 160,
              cost_usd: 0.00061,
              has_unknown_cost: false,
              context_usage_percent: 72.4,
              subagents: [
                {
                  session_id: "dev-session",
                  source_id: "agent-security",
                  label: "Security reviewer",
                  kind: "claude-sidechain",
                  sessions_with_usage: 1,
                  input_tokens: 20,
                  cache_creation_input_tokens: 2,
                  cache_read_input_tokens: 3,
                  output_tokens: 5,
                  total_tokens: 30,
                  cost_usd: 0.0002,
                  has_unknown_cost: false,
                  context_usage_percent: null,
                },
              ],
            },
            {
              kind: "review",
              sessions_with_usage: 1,
              input_tokens: 5,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 5,
              total_tokens: 10,
              cost_usd: null,
              has_unknown_cost: true,
              context_usage_percent: null,
            },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Total tokens170");
    expect(container.textContent).toContain("Total costn/a");
    expect(container.textContent).toContain("Max context72%");
    expect(container.textContent).toContain(
      "Some session costs are unavailable and counted as n/a.",
    );
    const detailsButton = getByRole("button", {
      name: "Show category details",
    });
    const detailsIcon = detailsButton.querySelector("svg");
    expect(detailsIcon).not.toBeNull();
    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    expect(detailsIcon?.classList.contains("rotate-90")).toBe(false);
    expect(container.textContent).not.toContain("By category");
    expect(container.textContent).not.toContain(
      "Implementation1 sessionTokens160Cost$0.0006Context72%",
    );
    expect(container.textContent).not.toContain("Subagents included in total");

    fireEvent.click(detailsButton);

    expect(detailsButton.getAttribute("aria-expanded")).toBe("true");
    expect(detailsIcon?.classList.contains("rotate-90")).toBe(true);
    expect(detailsButton.textContent).toContain("Hide category details");
    expect(container.textContent).toContain("By category");
    expect(container.textContent).toContain(
      "Implementation1 sessionTokens160Cost$0.0006Context72%",
    );
    expect(container.textContent).toContain(
      "Subagents included in totalSecurity reviewer: $0.0002, 30 tokens",
    );
    expect(container.textContent).toContain(
      "Review1 sessionTokens10Costn/aContextn/a",
    );
    expect(container.textContent).toContain("$0.0006");

    fireEvent.click(detailsButton);

    expect(detailsButton.getAttribute("aria-expanded")).toBe("false");
    expect(detailsIcon?.classList.contains("rotate-90")).toBe(false);
    expect(detailsButton.textContent).toContain("Show category details");
    expect(container.textContent).not.toContain("By category");
    expect(container.textContent).not.toContain(
      "Implementation1 sessionTokens160Cost$0.0006Context72%",
    );
  });

  it("shows an empty token usage state without noisy categories", () => {
    const { container, queryByRole } = render(
      <TokenUsageSummary
        usage={{
          sessions_with_usage: 0,
          input_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
          cost_usd: null,
          has_unknown_cost: false,
          context_usage_percent: null,
          by_kind: [],
        }}
      />,
    );

    expect(container.textContent).toContain("Total tokensn/a");
    expect(container.textContent).toContain("Total costn/a");
    expect(container.textContent).toContain("No token usage recorded yet.");
    expect(container.textContent).not.toContain("By category");
    expect(queryByRole("button", { name: "Show category details" })).toBeNull();
    expect(container.textContent).not.toContain("Subagents included in total");
    expect(container.textContent).not.toContain("Context usage is unavailable");
  });

  it("shows n/a when context usage is unavailable for recorded usage", () => {
    const { container, getByRole } = render(
      <TokenUsageSummary
        usage={{
          sessions_with_usage: 1,
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          output_tokens: 2,
          total_tokens: 12,
          cost_usd: 0.001,
          has_unknown_cost: false,
          context_usage_percent: null,
          by_kind: [
            {
              kind: "dev",
              sessions_with_usage: 1,
              input_tokens: 10,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
              output_tokens: 2,
              total_tokens: 12,
              cost_usd: 0.001,
              has_unknown_cost: false,
              context_usage_percent: null,
            },
          ],
        }}
      />,
    );

    expect(container.textContent).toContain("Max contextn/a");
    expect(container.textContent).not.toContain("Contextn/a");
    fireEvent.click(getByRole("button", { name: "Show category details" }));
    expect(container.textContent).toContain("Contextn/a");
    expect(container.textContent).toContain(
      "Context usage is unavailable for these sessions.",
    );
  });
});
