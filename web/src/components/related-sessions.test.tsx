import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
    expect(container.querySelectorAll("button").length).toBe(0);
    expect(container.textContent).toContain("resume from the linked PR");
    expect(container.textContent).toContain("review");
  });
});
