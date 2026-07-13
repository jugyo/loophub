import { HERDR_ID } from "./terminal-launch.ts";

export interface WorkflowPane {
  paneId: string;
  workspaceId: string;
}

export interface WorkflowPanePlacement {
  paneId: string;
  targetPaneId: string;
  split: "right" | "down";
  ratio: number;
}

export interface WorkflowPaneGridPlan {
  dimension: number;
  columns: number;
  rows: number;
  anchorPaneId: string;
  stagingPaneIds: string[];
  placements: WorkflowPanePlacement[];
}

function paneSequence(paneId: string): number | null {
  const match = paneId.match(/:p(\d+)$/u);
  return match ? Number(match[1]) : null;
}

function workflowPaneKind(
  label: unknown,
  runId: number,
): "parent" | "step" | null {
  if (typeof label !== "string") return null;
  if (/^workflow-[0-9a-f]{8}$/iu.test(label)) return "parent";
  const step = label.match(
    /^workflow (?:plan|execute|verify|reflect) #(\d+)$/u,
  );
  return step && Number(step[1]) === runId ? "step" : null;
}

/**
 * Reads the Workflow-owned panes in one tab. A foreign pane makes the operation unsafe: rebuilding
 * the tab around it would change a pane outside Workflow's scope, so the caller must surface an
 * error instead of laying out only a subset.
 */
export function parseWorkflowTabPanes(
  stdout: string,
  tabId: string,
  runId: number,
): WorkflowPane[] | null {
  try {
    const parsed = JSON.parse(stdout);
    const panes = parsed?.result?.panes;
    if (!Array.isArray(panes)) return null;
    const inTab = panes.filter((pane) => pane?.tab_id === tabId);
    const kinds = inTab.map((pane) => workflowPaneKind(pane?.label, runId));
    if (
      inTab.length === 0 ||
      kinds.some((kind) => kind === null) ||
      kinds.filter((kind) => kind === "parent").length !== 1
    ) {
      return null;
    }
    const result = inTab.map((pane, index) => ({
      paneId: pane?.pane_id,
      workspaceId: pane?.workspace_id,
      index,
    }));
    if (
      result.some(
        (pane) =>
          typeof pane.paneId !== "string" ||
          !HERDR_ID.test(pane.paneId) ||
          typeof pane.workspaceId !== "string" ||
          !HERDR_ID.test(pane.workspaceId),
      ) ||
      result.some((pane) => pane.workspaceId !== result[0]?.workspaceId)
    ) {
      return null;
    }
    return result
      .sort((a, b) => {
        const aSequence = paneSequence(a.paneId);
        const bSequence = paneSequence(b.paneId);
        if (
          aSequence !== null &&
          bSequence !== null &&
          aSequence !== bSequence
        ) {
          return aSequence - bSequence;
        }
        return a.index - b.index;
      })
      .map(({ paneId, workspaceId }) => ({ paneId, workspaceId }));
  } catch {
    return null;
  }
}

/**
 * Builds a row-major square-capacity grid. The dimension grows only after N² panes: 1, 2, 2, 2,
 * 3 ...; incomplete final rows/columns let their panes span the unused cells instead of creating
 * empty terminal panes. `rows` therefore describes the target grid, not only its occupied rows.
 */
export function workflowPaneGridPlan(paneIds: string[]): WorkflowPaneGridPlan {
  if (paneIds.length === 0)
    throw new Error("at least one Workflow pane is required");
  const dimension = Math.ceil(Math.sqrt(paneIds.length));
  const columns = dimension;
  const rows = dimension;
  const placements: WorkflowPanePlacement[] = [];

  for (
    let column = 1;
    column < columns && column < paneIds.length;
    column += 1
  ) {
    placements.push({
      paneId: paneIds[column],
      targetPaneId: paneIds[column - 1],
      split: "right",
      ratio: 1 / (columns - column + 1),
    });
  }
  for (let row = 1; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const index = row * columns + column;
      if (index >= paneIds.length) break;
      placements.push({
        paneId: paneIds[index],
        targetPaneId: paneIds[index - columns],
        split: "down",
        ratio: 1 / (rows - row + 1),
      });
    }
  }

  return {
    dimension,
    columns,
    rows,
    anchorPaneId: paneIds[0],
    stagingPaneIds: paneIds.slice(1),
    placements,
  };
}
