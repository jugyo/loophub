import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CommentAuthorLabel } from "./comment-author-label";

describe("CommentAuthorLabel", () => {
  it("shows the bot icon only for a persisted agent author type", () => {
    const { rerender } = render(
      <CommentAuthorLabel author="same-name" authorType="agent" />,
    );
    expect(screen.getByText("@same-name")).toBeTruthy();
    expect(screen.getByLabelText("AI agent")).toBeTruthy();

    rerender(<CommentAuthorLabel author="same-name" authorType="system" />);
    expect(screen.queryByLabelText("AI agent")).toBeNull();

    rerender(<CommentAuthorLabel author="same-name" authorType="human" />);
    expect(screen.getByText("@human")).toBeTruthy();
    expect(screen.queryByLabelText("AI agent")).toBeNull();
  });
});
