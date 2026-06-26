import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IssueDevInfo, PullDevInfo } from "./dev-info";

describe("IssueDevInfo", () => {
  it("shows lh dev with the owner/repo/id, plus the --sandbox AFK variant", () => {
    const { container } = render(
      <IssueDevInfo owner="jugyo" repo="loophub" number={150} />,
    );
    const commands = Array.from(container.querySelectorAll("code")).map(
      (c) => c.textContent,
    );
    expect(commands).toContain("lh dev jugyo/loophub/150");
    expect(commands).toContain("lh dev --sandbox jugyo/loophub/150");
    expect(container.textContent).toContain("Develop");
  });
});

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
