import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { IssueDevInfo, PullDevInfo } from "./dev-info";

describe("IssueDevInfo", () => {
  it("shows lh dev with the owner/repo/id, and hides the --sandbox variant", () => {
    const { container } = render(
      <IssueDevInfo owner="jugyo" repo="loophub" number={150} />,
    );
    const commands = Array.from(container.querySelectorAll("code")).map(
      (c) => c.textContent,
    );
    expect(commands).toContain("lh dev jugyo/loophub/150");
    // `--sandbox` is a hidden flag for now (Claude Code's macOS sandbox is broken — see #343);
    // the UI must not advertise it.
    expect(commands).not.toContain("lh dev --sandbox jugyo/loophub/150");
    expect(container.textContent).not.toContain("--sandbox");
    expect(container.textContent).toContain("Develop");
  });

  it("also shows the --auto (unattended) variant with a note, keeping the normal launch", () => {
    const { container } = render(
      <IssueDevInfo owner="jugyo" repo="loophub" number={150} />,
    );
    const commands = Array.from(container.querySelectorAll("code")).map(
      (c) => c.textContent,
    );
    // The normal launch stays alongside the auto-mode variant (#374).
    expect(commands).toContain("lh dev jugyo/loophub/150");
    expect(commands).toContain("lh dev --auto jugyo/loophub/150");
    // A short note explains the unattended/auto-mode behaviour.
    expect(container.textContent).toContain("auto mode");
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
