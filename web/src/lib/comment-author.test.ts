import { describe, expect, it } from "vitest";
import { commentAuthor } from "./comment-author";

describe("commentAuthor", () => {
  it("shows a human post as @human whatever actor name it was stored under", () => {
    expect(commentAuthor({ user: { login: "me" }, author_type: "human" })).toBe(
      "human",
    );
    expect(
      commentAuthor({ user: { login: "unknown" }, author_type: "human" }),
    ).toBe("human");
  });

  it("keeps the stored author for agent and system posts", () => {
    expect(
      commentAuthor({ user: { login: "design-bot" }, author_type: "agent" }),
    ).toBe("design-bot");
    expect(
      commentAuthor({ user: { login: "unknown" }, author_type: "system" }),
    ).toBe("unknown");
  });
});
