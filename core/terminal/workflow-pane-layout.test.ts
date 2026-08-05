import { describe, expect, test } from "vitest";
import {
  layoutWorkflowTab,
  parsePreviousWorkflowVerifyPane,
  parseWorkflowRunTab,
  WorkflowPaneLayoutError,
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

  test("resolves the run's tab from its anchor pane, ordered by launch sequence", () => {
    // Real Herdr pane ids are opaque counters (`w1:pX`), not a decimal creation order, and the list
    // order does not follow the launch order either. Only the labels LoopHub wrote can order them.
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:pX",
            tab_id: "w1:t2",
            workspace_id: "w1",
            label: "verifier #7-3",
          },
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "dev #4",
          },
          {
            pane_id: "w1:pB",
            tab_id: "w1:t2",
            workspace_id: "w1",
            label: "executor #7-2",
          },
          {
            pane_id: "w1:p9",
            tab_id: "w1:t2",
            workspace_id: "w1",
            label: "orchestrator #7",
          },
        ],
      },
    });
    expect(parseWorkflowRunTab(stdout, "w1:p9", 7)).toEqual({
      tabId: "w1:t2",
      workspaceId: "w1",
      paneIds: ["w1:p9", "w1:pB", "w1:pX"],
    });
  });

  test("keeps an existing run's legacy panes eligible for grid layout", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "workflow-a1b2c3d4",
          },
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "workflow execute #7",
          },
        ],
      },
    });
    expect(parseWorkflowRunTab(stdout, "w1:p1", 7)).toEqual({
      tabId: "w1:t1",
      workspaceId: "w1",
      paneIds: ["w1:p1", "w1:p2"],
    });
  });

  test("refuses to change a tab containing a non-Workflow pane", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "orchestrator #7",
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
    expect(parseWorkflowRunTab(stdout, "w1:p1", 7)).toBeNull();
  });

  test("refuses to move a step pane from another Workflow run", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          {
            pane_id: "w1:p1",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "orchestrator #7",
          },
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "verifier #8-1",
          },
        ],
      },
    });
    expect(parseWorkflowRunTab(stdout, "w1:p1", 7)).toBeNull();
  });

  test("refuses an anchor that is missing, is a step pane, or shares its tab with a second parent", () => {
    const panes = [
      {
        pane_id: "w1:p1",
        tab_id: "w1:t1",
        workspace_id: "w1",
        label: "orchestrator #7",
      },
      {
        pane_id: "w1:p2",
        tab_id: "w1:t1",
        workspace_id: "w1",
        label: "executor #7-1",
      },
    ];
    const stdout = JSON.stringify({ result: { panes } });
    expect(parseWorkflowRunTab(stdout, "w1:p9", 7)).toBeNull();
    expect(parseWorkflowRunTab(stdout, "w1:p2", 7)).toBeNull();
    expect(
      parseWorkflowRunTab(
        JSON.stringify({
          result: {
            panes: [
              ...panes,
              {
                pane_id: "w1:p3",
                tab_id: "w1:t1",
                workspace_id: "w1",
                label: "workflow-a1b2c3d4",
              },
            ],
          },
        }),
        "w1:p1",
        7,
      ),
    ).toBeNull();
  });

  test("finds only the latest Verify pane for the requested Workflow run", () => {
    const stdout = JSON.stringify({
      result: {
        panes: [
          { pane_id: "w1:p1", label: "orchestrator #7" },
          { pane_id: "w1:p2", label: "executor #7-4" },
          { pane_id: "w1:p3", label: "verifier #7-2" },
          { pane_id: "w1:p4", label: "verifier #8-9" },
          { pane_id: "w1:p5", label: "verifier #7-5" },
        ],
      },
    });

    expect(parsePreviousWorkflowVerifyPane(stdout, 7)).toEqual({
      paneId: "w1:p5",
    });
  });

  test("recognizes a legacy Verify pane and distinguishes no match from invalid output", () => {
    expect(
      parsePreviousWorkflowVerifyPane(
        JSON.stringify({
          result: {
            panes: [
              { pane_id: "w1:p1", label: "workflow execute #7" },
              { pane_id: "w1:p2", label: "workflow verify #7" },
              { pane_id: "w1:p3", label: "workflow verify #8" },
            ],
          },
        }),
        7,
      ),
    ).toEqual({ paneId: "w1:p2" });
    expect(
      parsePreviousWorkflowVerifyPane(
        JSON.stringify({ result: { panes: [] } }),
        7,
      ),
    ).toEqual({ paneId: null });
    expect(parsePreviousWorkflowVerifyPane("not json", 7)).toBeNull();
  });

  test("rejects an invalid pane id on the selected Verify pane", () => {
    expect(
      parsePreviousWorkflowVerifyPane(
        JSON.stringify({
          result: {
            panes: [{ pane_id: "not a pane id", label: "verifier #7-2" }],
          },
        }),
        7,
      ),
    ).toBeNull();
  });
});

describe("Workflow tab layout", () => {
  const paneListJson = (panes: unknown[]) =>
    JSON.stringify({ result: { panes } });
  const TAB_CREATE_JSON = JSON.stringify({
    result: { tab: { tab_id: "w1:t3" }, root_pane: { pane_id: "w1:p10" } },
  });

  // A fake Herdr seam: records every invocation and replies from `stdout` keyed by the command's
  // first two words, so a test states only the responses the layout actually reads.
  function fakeHerdr(stdout: Record<string, string>, fails?: string) {
    const commands: string[] = [];
    const herdr = (args: string[], opts?: { captureStdout?: boolean }) => {
      const command = args.join(" ");
      commands.push(command);
      if (fails && command.startsWith(fails)) {
        throw new Error("herdr exited with status 7");
      }
      return opts?.captureStdout
        ? (stdout[args.slice(0, 2).join(" ")] ?? "")
        : "";
    };
    return { commands, herdr };
  }

  test("stages panes off the tab, replays the grid, then drops the staging tab", () => {
    const { commands, herdr } = fakeHerdr({
      "pane list": paneListJson([
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "orchestrator #7",
        },
        {
          pane_id: "w1:p3",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "executor #7-1",
        },
        {
          pane_id: "w1:p4",
          tab_id: "w1:t2",
          workspace_id: "w1",
          label: "unrelated",
        },
      ]),
      "tab create": TAB_CREATE_JSON,
    });

    layoutWorkflowTab({ anchorPaneId: "w1:p2", runId: 7, herdr });

    expect(commands).toEqual([
      "pane list",
      "tab create --workspace w1 --no-focus",
      "pane move w1:p3 --tab w1:t3 --split down --target-pane w1:p10 --ratio 0.5 --no-focus",
      "pane move w1:p3 --tab w1:t1 --split right --target-pane w1:p2 --ratio 0.5 --no-focus",
      "tab close w1:t3",
    ]);
    // Layout is ancillary to a launch that already happened: it must never focus or zoom.
    expect(
      commands.some((c) =>
        /focus(?!$)|zoom/.test(c.replace(/--no-focus/g, "")),
      ),
    ).toBe(false);
  });

  test("does nothing beyond reading the panes when the tab holds a single pane", () => {
    const { commands, herdr } = fakeHerdr({
      "pane list": paneListJson([
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "orchestrator #7",
        },
      ]),
    });

    layoutWorkflowTab({ anchorPaneId: "w1:p2", runId: 7, herdr });

    expect(commands).toEqual(["pane list"]);
  });

  test("refuses to rebuild a tab that holds a foreign pane", () => {
    const { commands, herdr } = fakeHerdr({
      "pane list": paneListJson([
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "orchestrator #7",
        },
        {
          pane_id: "w1:p3",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "someone else",
        },
      ]),
    });

    expect(() =>
      layoutWorkflowTab({ anchorPaneId: "w1:p2", runId: 7, herdr }),
    ).toThrow(
      /pane w1:p2 is not the only parent pane of a tab holding just run #7's panes/,
    );
    expect(commands).toEqual(["pane list"]);
  });

  test("rebuilds the tab the anchor pane is in, never the caller's idea of it", () => {
    // The parent pane sits in w1:t9 while an unrelated tab holds a look-alike Workflow pane. The
    // rebuild must follow the anchor and leave the other tab alone.
    const { commands, herdr } = fakeHerdr({
      "pane list": paneListJson([
        {
          pane_id: "w1:p5",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "executor #7-9",
        },
        {
          pane_id: "w2:p2",
          tab_id: "w2:t9",
          workspace_id: "w2",
          label: "orchestrator #7",
        },
        {
          pane_id: "w2:p3",
          tab_id: "w2:t9",
          workspace_id: "w2",
          label: "executor #7-1",
        },
      ]),
      "tab create": TAB_CREATE_JSON,
    });

    layoutWorkflowTab({ anchorPaneId: "w2:p2", runId: 7, herdr });

    expect(commands).toEqual([
      "pane list",
      "tab create --workspace w2 --no-focus",
      "pane move w2:p3 --tab w1:t3 --split down --target-pane w1:p10 --ratio 0.5 --no-focus",
      "pane move w2:p3 --tab w2:t9 --split right --target-pane w2:p2 --ratio 0.5 --no-focus",
      "tab close w1:t3",
    ]);
  });

  test("never stages the anchor pane, whatever order Herdr lists the tab in", () => {
    const { commands, herdr } = fakeHerdr({
      "pane list": paneListJson([
        {
          pane_id: "w1:pB",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "verifier #7-2",
        },
        {
          pane_id: "w1:pX",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "executor #7-1",
        },
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "orchestrator #7",
        },
      ]),
      "tab create": TAB_CREATE_JSON,
    });

    layoutWorkflowTab({ anchorPaneId: "w1:p2", runId: 7, herdr });

    expect(commands.filter((c) => c.startsWith("pane move"))).toEqual([
      "pane move w1:pX --tab w1:t3 --split down --target-pane w1:p10 --ratio 0.5 --no-focus",
      "pane move w1:pB --tab w1:t3 --split down --target-pane w1:p10 --ratio 0.5 --no-focus",
      "pane move w1:pX --tab w1:t1 --split right --target-pane w1:p2 --ratio 0.5 --no-focus",
      "pane move w1:pB --tab w1:t1 --split down --target-pane w1:p2 --ratio 0.5 --no-focus",
    ]);
  });

  test("surfaces invalid tab create JSON before moving any pane", () => {
    const { commands, herdr } = fakeHerdr({
      "pane list": paneListJson([
        {
          pane_id: "w1:p2",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "orchestrator #7",
        },
        {
          pane_id: "w1:p3",
          tab_id: "w1:t1",
          workspace_id: "w1",
          label: "executor #7-1",
        },
      ]),
      "tab create": "not json",
    });

    expect(() =>
      layoutWorkflowTab({ anchorPaneId: "w1:p2", runId: 7, herdr }),
    ).toThrow(/herdr tab create returned invalid JSON/);
    expect(commands).not.toContain(
      "pane move w1:p3 --tab w1:t3 --split down --target-pane w1:p10 --ratio 0.5 --no-focus",
    );
  });

  test("wraps a failed Herdr command as a layout error and stops the rebuild", () => {
    const { commands, herdr } = fakeHerdr(
      {
        "pane list": paneListJson([
          {
            pane_id: "w1:p2",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "orchestrator #7",
          },
          {
            pane_id: "w1:p3",
            tab_id: "w1:t1",
            workspace_id: "w1",
            label: "executor #7-1",
          },
        ]),
        "tab create": TAB_CREATE_JSON,
      },
      "pane move",
    );

    expect(() =>
      layoutWorkflowTab({ anchorPaneId: "w1:p2", runId: 7, herdr }),
    ).toThrow(new WorkflowPaneLayoutError("herdr exited with status 7"));
    // No cleanup of the half-staged rebuild: the failure is left visible for a human.
    expect(commands).not.toContain("tab close w1:t3");
  });
});
