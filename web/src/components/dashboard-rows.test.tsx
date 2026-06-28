import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Issue, LinkedPull } from "@/api/types";
import { IssueRow } from "./dashboard-rows";

afterEach(cleanup);

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 1,
    state: "open",
    title: "Example issue",
    body: "",
    user: { login: "me" },
    labels: [],
    comments: 0,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

// IssueRow renders <Link>, which needs a router context.
function renderInRouter(ui: React.ReactNode) {
  const rootRoute = createRootRoute({ component: Outlet });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => <>{ui}</>,
  });
  const detailRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/issues/$number",
    component: () => null,
  });
  const pullRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/r/$owner/$repo/pulls/$number",
    component: () => null,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, detailRoute, pullRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router} />);
}

function makePull(overrides: Partial<LinkedPull> = {}): LinkedPull {
  return {
    number: 10,
    title: "A PR",
    state: "open",
    merged: false,
    ...overrides,
  };
}

describe("IssueRow", () => {
  it("shows the issue labels", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          labels: [{ name: "bug" }, { name: "ready-to-build" }],
        })}
      />,
    );
    expect(await screen.findByText("bug")).toBeTruthy();
    expect(screen.getByText("ready-to-build")).toBeTruthy();
  });

  it("renders no label chips when there are none", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ labels: [] })} />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByText("bug")).toBeNull();
  });

  it("links the title to the issue and the pill to the PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [makePull({ number: 10, working: true })],
        })}
      />,
    );
    const title = await screen.findByRole("link", { name: "Example issue" });
    expect(title.getAttribute("href")).toBe("/r/me/proj/issues/1");
    const pill = screen.getByRole("link", { name: "PR #10" });
    expect(pill.getAttribute("href")).toBe("/r/me/proj/pulls/10");
    expect(screen.getByText("working")).toBeTruthy();
  });

  it("stacks one sub-row per linked PR when there are several", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, working: true }),
            makePull({ number: 9, merged: true, state: "closed" }),
          ],
        })}
      />,
    );
    expect(await screen.findByRole("link", { name: "PR #10" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #9" })).toBeTruthy();
    expect(screen.getByText("working")).toBeTruthy();
    expect(screen.getByText("merged")).toBeTruthy();
  });

  it("shows a check icon on an approved linked PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, review_state: "APPROVED" }),
          ],
        })}
      />,
    );
    expect(await screen.findByText("approved")).toBeTruthy();
    expect(screen.getByLabelText("approved")).toBeTruthy();
  });

  it("shows no check icon on a non-approved linked PR", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          linked_pull_requests: [
            makePull({ number: 10, review_state: "CHANGES_REQUESTED" }),
          ],
        })}
      />,
    );
    expect(await screen.findByText("changes")).toBeTruthy();
    expect(screen.queryByLabelText("approved")).toBeNull();
  });

  it("renders a single row (no PR sub-row) when no PR is linked", async () => {
    renderInRouter(<IssueRow owner="me" repo="proj" issue={makeIssue()} />);
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("link", { name: /^PR #/ })).toBeNull();
  });

  it("drops the open badge", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ state: "open" })} />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByText("open")).toBeNull();
  });

  it("shows the closed badge under the closed filter", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({ state: "closed" })}
      />,
    );
    expect(await screen.findByText("closed")).toBeTruthy();
  });

  // The Build button mirrors the issue-detail Build trigger: visible unless a
  // linked PR is actively in progress (open) or already merged (done).
  it("shows the Build button when no PR is linked", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    expect(
      await screen.findByRole("button", { name: "Build issue #7" }),
    ).toBeTruthy();
  });

  it("renders the Build button always visible (not hover-revealed)", async () => {
    renderInRouter(
      <IssueRow owner="me" repo="proj" issue={makeIssue({ number: 7 })} />,
    );
    const button = await screen.findByRole("button", {
      name: "Build issue #7",
    });
    // No opacity-0 / hover-reveal classes: the button must show without hover so
    // a label row's layout does not shift on the button appearing/disappearing.
    expect(button.className).not.toContain("opacity-0");
    expect(button.className).not.toContain("group-hover:opacity-100");
  });

  it("shows the Build button when the linked PR is closed unmerged (rejected)", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          number: 7,
          linked_pull_requests: [makePull({ state: "closed", merged: false })],
        })}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "Build issue #7" }),
    ).toBeTruthy();
  });

  it("hides the Build button while a linked PR is open", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          number: 7,
          linked_pull_requests: [makePull({ state: "open", merged: false })],
        })}
      />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build issue #7" })).toBeNull();
  });

  it("hides the Build button once a linked PR is merged", async () => {
    renderInRouter(
      <IssueRow
        owner="me"
        repo="proj"
        issue={makeIssue({
          number: 7,
          linked_pull_requests: [makePull({ state: "closed", merged: true })],
        })}
      />,
    );
    expect(await screen.findByText("Example issue")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Build issue #7" })).toBeNull();
  });
});
