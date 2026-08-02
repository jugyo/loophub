import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommentAuthorLabel } from "./comment-author-label";

describe("CommentAuthorLabel", () => {
  it("shows the bot icon only for a persisted agent author type", () => {
    const { rerender } = render(
      <CommentAuthorLabel author="same-name" authorType="agent" />,
    );
    expect(screen.getByText("@same-name")).toBeTruthy();
    const agentIcon = screen.getByLabelText("AI agent");
    expect(agentIcon.className).toContain("bg-primary-subtle");
    expect(agentIcon.className).toContain("text-link");
    expect(agentIcon.className).not.toContain("text-muted-foreground");

    rerender(<CommentAuthorLabel author="same-name" authorType="system" />);
    expect(screen.queryByLabelText("AI agent")).toBeNull();

    rerender(<CommentAuthorLabel author="same-name" authorType="human" />);
    expect(screen.getByText("@human")).toBeTruthy();
    expect(screen.queryByLabelText("AI agent")).toBeNull();
  });
});
