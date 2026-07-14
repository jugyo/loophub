import {
  parseWorkflowHerdrAgentName,
  workflowHerdrPaneKind,
} from "../workflow/herdr-agents.ts";
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
  return workflowHerdrPaneKind(label, runId);
}

/**
 * Finds the most recently launched Verify pane for one Workflow run. `null` means the Herdr
 * response is unsafe to act on; `{ paneId: null }` means the response is valid and no prior Verify
 * pane exists. Legacy Verify labels remain eligible so an in-flight run can clean up after an
 * upgrade.
 */
export function parsePreviousWorkflowVerifyPane(
  stdout: string,
  runId: number,
): { paneId: string | null } | null {
  try {
    const parsed = JSON.parse(stdout);
    const panes = parsed?.result?.panes;
    if (!Array.isArray(panes)) return null;
    const candidates: Array<{
      paneId: unknown;
      sequence: number;
      index: number;
    }> = [];

    for (const [index, pane] of panes.entries()) {
      const agent = parseWorkflowHerdrAgentName(pane?.label);
      if (
        agent?.kind === "step" &&
        agent.runId === runId &&
        agent.step === "verify"
      ) {
        candidates.push({
          paneId: pane?.pane_id,
          sequence: agent.sequence,
          index,
        });
        continue;
      }
      if (pane?.label === `workflow verify #${runId}`) {
        candidates.push({ paneId: pane?.pane_id, sequence: 0, index });
      }
    }

    if (candidates.length === 0) return { paneId: null };
    const latest = candidates.sort(
      (a, b) => b.sequence - a.sequence || b.index - a.index,
    )[0];
    return typeof latest.paneId === "string" && HERDR_ID.test(latest.paneId)
      ? { paneId: latest.paneId }
      : null;
  } catch {
    return null;
  }
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
