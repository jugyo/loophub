import { fireEvent, render, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RelatedSession } from "@/api/types";
import { RelatedSessions } from "./related-sessions";

function session(over: Partial<RelatedSession>): RelatedSession {
  return {
    id: "id",
    agent: "lh-dev",
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

  it("gives every session in a PR worktree a Resume button — no anchor singling-out, no reason text (#401)", () => {
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
    // Both sessions resume in the shared worktree, so both get a Resume button.
    expect(resumeButtons(container).length).toBe(2);
    // The old muted anchor reasons are gone entirely.
    expect(container.textContent).not.toContain(
      "superseded by a newer dev session",
    );
    expect(container.textContent).not.toContain("not this PR's resume target");
    expect(container.textContent).toContain("Sessions");
  });

  it("the Resume button launches `cd <cwd> && claude --resume <id>` in the terminal", () => {
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
    const [btn] = resumeButtons(container);
    // The single-line command (no `\` line-continuation — that is only for the copyable block).
    expect(btn.getAttribute("title")).toBe(
      "Resume `cd /home/me/.loophub/worktrees/jugyo/loophub/issue-7 && claude --resume 11111111-2222-3333-4444-555555555555` in a terminal",
    );
  });

  it("on issue detail (no cwd): an issue-create session resumes from the repo root; a worktree-less session has no button but still expands to a command", () => {
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
    // Only the issue-create session (repo-root cwd) can launch in the terminal; the review session
    // has no client-side worktree path, so no button — but no reason text either.
    const btns = resumeButtons(container);
    expect(btns.length).toBe(1);
    // Its command is the bare `claude --resume <id>` (no `cd`, runs at the repo root).
    expect(btns[0].getAttribute("title")).toBe(
      "Resume `claude --resume 11111111-2222-3333-4444-555555555555` in a terminal",
    );
    expect(container.textContent).not.toContain("resume from the linked PR");
    // The button-less review session still exposes the copyable command when expanded.
    const reviewLi = container.querySelectorAll("li")[1] as HTMLElement;
    fireEvent.click(within(reviewLi).getByRole("button", { expanded: false }));
    expect(reviewLi.textContent).toContain(
      "claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
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
    // The Resume button is present alongside the command.
    expect(resumeButtons(li).length).toBe(1);
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
});
