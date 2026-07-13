import { describe, expect, test } from "vitest";
import {
  parseWorkflowTabPanes,
  workflowPaneGridPlan,
} from "./workflow-pane-layout.ts";

describe("Workflow pane grid", () => {
  test.each([
    [1, 1, 1, 1],
    [2, 2, 2, 2],
    [4, 2, 2, 2],
    [5, 3, 3, 3],
    [9, 3, 3, 3],
  ])("%i panes use a %i×%i capacity grid with %i target rows", (count, dimension, columns, rows) => {
    const ids = Array.from({ length: count }, (_, index) => `w1:p${index + 1}`);
    expect(workflowPaneGridPlan(ids)).toMatchObject({
      dimension,
      columns,
      rows,
      anchorPaneId: "w1:p1",
      stagingPaneIds: ids.slice(1),
    });
  });

  test("grows only after the current square capacity is exceeded", () => {
    expect(workflowPaneGridPlan(["p1", "p2", "p3", "p4"]).dimension).toBe(2);
    expect(workflowPaneGridPlan(["p1", "p2", "p3", "p4", "p5"]).dimension).toBe(
      3,
    );
    expect(
      workflowPaneGridPlan(
        Array.from({ length: 10 }, (_, index) => `p${index}`),
      ).dimension,
    ).toBe(4);
  });

  test("places panes in stable row-major order with balanced split ratios", () => {
    const plan = workflowPaneGridPlan(
      Array.from({ length: 9 }, (_, index) => `w1:p${index + 1}`),
    );
    expect(plan.placements).toEqual([
      { paneId: "w1:p2", targetPaneId: "w1:p1", split: "right", ratio: 1 / 3 },
      { paneId: "w1:p3", targetPaneId: "w1:p2", split: "right", ratio: 1 / 2 },
      { paneId: "w1:p4", targetPaneId: "w1:p1", split: "down", ratio: 1 / 3 },
      { paneId: "w1:p5", targetPaneId: "w1:p2", split: "down", ratio: 1 / 3 },
      { paneId: "w1:p6", targetPaneId: "w1:p3", split: "down", ratio: 1 / 3 },
      { paneId: "w1:p7", targetPaneId: "w1:p4", split: "down", ratio: 1 / 2 },
      { paneId: "w1:p8", targetPaneId: "w1:p5", split: "down", ratio: 1 / 2 },
      { paneId: "w1:p9", targetPaneId: "w1:p6", split: "down", ratio: 1 / 2 },
    ]);
  });

  test("lets five panes span unused cells in a three-by-three target grid", () => {
    const plan = workflowPaneGridPlan([
      "w1:p1",
      "w1:p2",
      "w1:p3",
      "w1:p4",
      "w1:p5",
    ]);
    expect(plan.rows).toBe(3);
    expect(plan.placements.slice(-2)).toEqual([
      { paneId: "w1:p4", targetPaneId: "w1:p1", split: "down", ratio: 1 / 3 },
      { paneId: "w1:p5", targetPaneId: "w1:p2", split: "down", ratio: 1 / 3 },
    ]);
  });

  test("parses only Workflow panes in creation order", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p11",
            tab_id: "w1:t2",
            workspace_id: "w1",
            label: "workflow execute #7",
          },
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "dev #4",
          },
          {
            pane_id: "w1:p10",
            tab_id: "w1:t2",
            workspace_id: "w1",
            label: "workflow-ABCDEF12",
          },
        ],
      },
    });
    expect(parseWorkflowTabPanes(stdout, "w1:t2", 7)).toEqual([
      { paneId: "w1:p10", workspaceId: "w1" },
      { paneId: "w1:p11", workspaceId: "w1" },
    ]);
  });

  test("refuses to change a tab containing a non-Workflow pane", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "workflow-11111111",
          },
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "unrelated",
          },
        ],
      },
    });
    expect(parseWorkflowTabPanes(stdout, "w1:t1", 7)).toBeNull();
  });

  test("refuses to move a step pane from another Workflow run", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "workflow-11111111",
          },
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "workflow execute #8",
          },
        ],
      },
    });
    expect(parseWorkflowTabPanes(stdout, "w1:t1", 7)).toBeNull();
  });
});
