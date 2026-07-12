import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PullDevInfo } from "./dev-info";

describe("PullDevInfo", () => {
  it("shows lh resume with the owner/repo/id", () => {
    const { container } = render(
      <PullDevInfo owner="jugyo" repo="loophub" number={188} />,
    );
    const commands = Array.from(container.querySelectorAll("code")).map(
      (c) => c.textContent,
    );
    expect(commands).toContain("lh resume jugyo/loophub/188");
  });
});
