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

describe("RelatedSessions", () => {
  it("renders nothing when there are no sessions", () => {
    const { container } = render(
      <RelatedSessions owner="jugyo" repo="loophub" sessions={[]} />,
    );
    expect(container.textContent).toBe("");
  });

  it("shows a Resume button for a resumable PR session and the reason otherwise", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        resumeNumber={42}
        sessions={[
          session({ id: "a", kind: "dev", resume: { resumable: true } }),
          session({
            id: "b",
            kind: "dev",
            resume: { resumable: false, reason: "superseded" },
          }),
        ]}
      />,
    );
    const buttons = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    // Exactly one Resume button (for the resumable session).
    expect(buttons.filter((t) => t?.includes("Resume")).length).toBe(1);
    // The superseded session shows its reason instead.
    expect(container.textContent).toContain(
      "superseded by a newer dev session",
    );
    expect(container.textContent).toContain("Sessions");
  });

  it("never offers Resume on an issue (no resumeNumber); shows resume-via-pull reason", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        sessions={[
          session({
            id: "r",
            kind: "review",
            resume: { resumable: false, reason: "resume-via-pull" },
          }),
        ]}
      />,
    );
    // No `lh resume` Resume button on an issue (only the expand toggle remains).
    const labels = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent,
    );
    expect(labels.some((t) => t?.includes("Resume"))).toBe(false);
    expect(container.textContent).toContain("resume from the linked PR");
    expect(container.textContent).toContain("review");
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
        resumeNumber={42}
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
    expect(
      within(li).queryByRole("button", { name: "Copy directory" }),
    ).toBeNull();
    // The Resume (lh resume) button is still present alongside the command.
    expect(
      Array.from(li.querySelectorAll("button")).some((b) =>
        b.textContent?.includes("Resume"),
      ),
    ).toBe(true);
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
            resume: { resumable: false, reason: "resume-via-pull" },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    // No cwd → no `cd` prefix, just the bare command.
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
        resumeNumber={42}
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
        resumeNumber={42}
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

  it("shows the claude command for a superseded session that lh resume cannot reach", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        resumeNumber={42}
        sessions={[
          session({
            id: "b",
            kind: "dev",
            session: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            resume: { resumable: false, reason: "superseded" },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    expect(li.textContent).toContain(
      "claude --resume aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  it("shows the reason instead of a command when the runtime has no claude session", () => {
    const { container } = render(
      <RelatedSessions
        owner="jugyo"
        repo="loophub"
        resumeNumber={42}
        sessions={[
          session({
            id: "c",
            kind: "review",
            resume: { resumable: false, reason: "no-session" },
          }),
        ]}
      />,
    );
    const li = container.querySelector("li") as HTMLElement;
    fireEvent.click(toggles(container)[0]);
    expect(li.textContent).not.toContain("claude --resume");
    expect(li.textContent).toContain("Cannot resume from a terminal");
    // The reason is shown without the old redundant "not resumable: not resumable" doubling.
    expect(li.textContent).not.toContain("Not resumable: not resumable");
  });
});
