import {
  parseWorkflowHerdrAgentName,
  workflowHerdrPaneKind,
} from "../workflow/herdr-agents.ts";
import {
  HERDR_ID,
  parseHerdrRootPaneId,
  parseHerdrTabId,
} from "./terminal-launch.ts";

/**
 * One Workflow run's tab, resolved from its anchor pane. `paneIds` is the layout order: the anchor
 * first, then the run's step panes in launch order.
 */
export interface WorkflowRunTab {
  tabId: string;
  workspaceId: string;
  paneIds: string[];
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

function isHerdrId(value: unknown): value is string {
  return typeof value === "string" && HERDR_ID.test(value);
}

/**
 * The launch order of a step pane, taken from the child sequence LoopHub itself put in the label
 * ("executor #7-3"). Herdr's own pane ids are opaque counters (`w14Z:pX`), so they cannot order a
 * tab; the sequence LoopHub assigns at launch can. Legacy panes predate the sequence and sort last,
 * in the order Herdr listed them.
 */
function stepLaunchSequence(label: unknown): number | null {
  const agent = parseWorkflowHerdrAgentName(label);
  return agent?.kind === "step" ? agent.sequence : null;
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
 * Resolves a run's tab from its anchor pane — the pane its parent agent runs in, as the launch
 * recorded it. The tab is whichever tab Herdr *currently* reports the anchor in, so a caller can
 * never name a tab that has since stopped holding the run (nor one it merely inherited from its own
 * environment); pane and tab come from a single observation and cannot disagree.
 *
 * `null` means the tab is unsafe to rebuild, and the caller must surface an error rather than lay
 * out part of it: the anchor is absent or not this run's parent pane, a second pane claims to be the
 * parent, or a pane in the tab belongs to another run or to nobody — rebuilding around any of those
 * would move a pane outside this run's scope.
 */
export function parseWorkflowRunTab(
  stdout: string,
  anchorPaneId: string,
  runId: number,
): WorkflowRunTab | null {
  let panes: unknown;
  try {
    panes = JSON.parse(stdout)?.result?.panes;
  } catch {
    return null;
  }
  if (!Array.isArray(panes)) return null;

  const anchor = panes.find((pane) => pane?.pane_id === anchorPaneId);
  const tabId = anchor?.tab_id;
  const workspaceId = anchor?.workspace_id;
  if (
    !isHerdrId(anchorPaneId) ||
    !isHerdrId(tabId) ||
    !isHerdrId(workspaceId) ||
    workflowHerdrPaneKind(anchor?.label, runId) !== "parent"
  ) {
    return null;
  }

  const ordered: Array<{
    paneId: string;
    parent: boolean;
    sequence: number;
    index: number;
  }> = [];
  for (const [index, pane] of panes.entries()) {
    if (pane?.tab_id !== tabId) continue;
    const paneId = pane?.pane_id;
    const kind = workflowHerdrPaneKind(pane?.label, runId);
    if (!isHerdrId(paneId) || pane?.workspace_id !== workspaceId) return null;
    if (kind === null) return null;
    // A second parent pane in the tab means the anchor is not the only candidate, so which pane the
    // grid is built around would again depend on who asked. Refuse instead of picking one.
    if (kind === "parent" && paneId !== anchorPaneId) return null;
    ordered.push({
      paneId,
      parent: kind === "parent",
      sequence: stepLaunchSequence(pane?.label) ?? Number.MAX_SAFE_INTEGER,
      index,
    });
  }

  // A total order, so the grid a tab produces depends only on the tab's contents: the anchor, then
  // step panes by launch order, then anything without a sequence in Herdr's listing order.
  ordered.sort(
    (a, b) =>
      Number(b.parent) - Number(a.parent) ||
      a.sequence - b.sequence ||
      a.index - b.index,
  );
  return {
    tabId,
    workspaceId,
    paneIds: ordered.map((pane) => pane.paneId),
  };
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

/**
 * The Herdr command seam `layoutWorkflowTab` drives. It runs one `herdr` invocation against the
 * caller's session and returns its stdout when `captureStdout` is set, "" otherwise. Any failure
 * (spawn error, signal, non-zero exit) must throw; layoutWorkflowTab surfaces it as a
 * WorkflowPaneLayoutError rather than continuing a half-applied rebuild.
 */
export type WorkflowPaneLayoutHerdr = (
  args: string[],
  opts?: { captureStdout?: boolean },
) => string;

export class WorkflowPaneLayoutError extends Error {
  constructor(detail: string) {
    super(`failed to layout Workflow panes: ${detail}`);
    this.name = "WorkflowPaneLayoutError";
  }
}

function runLayoutCommand(
  herdr: WorkflowPaneLayoutHerdr,
  args: string[],
  captureStdout = false,
): string {
  try {
    return herdr(args, { captureStdout });
  } catch (e: any) {
    throw new WorkflowPaneLayoutError(e?.message ?? String(e));
  }
}

/**
 * Rebuilds a run's tab as a balanced grid: read the panes, stage them on a scratch tab, move them
 * back in grid order, then drop the scratch tab. The staging detour exists because Herdr can only
 * split against a pane that is already in the target tab; moving panes out first frees the anchor's
 * geometry so each placement lands where the plan says.
 *
 * The tab is named by `anchorPaneId` rather than by a tab id, because the anchor is what the run
 * actually owns: it is the run's parent pane, it is the grid's first cell, and it is therefore the
 * one pane the rebuild never moves. Whatever else goes wrong, the parent agent stays where it was.
 *
 * Every mutation is `--no-focus`: layout is ancillary to a launch that already happened, so it must
 * never steal focus from an unrelated tab (the regression in 65cda7cf). Failures throw
 * WorkflowPaneLayoutError and are left for a human — no cleanup or retry of a partial rebuild.
 */
export function layoutWorkflowTab(input: {
  anchorPaneId: string;
  runId: number;
  herdr: WorkflowPaneLayoutHerdr;
}): void {
  const { anchorPaneId, runId, herdr } = input;
  const paneList = runLayoutCommand(herdr, ["pane", "list"], true);
  const tab = parseWorkflowRunTab(paneList, anchorPaneId, runId);
  if (!tab) {
    throw new WorkflowPaneLayoutError(
      `pane ${anchorPaneId} is not the only parent pane of a tab holding just run #${runId}'s panes`,
    );
  }
  const plan = workflowPaneGridPlan(tab.paneIds);
  if (plan.stagingPaneIds.length === 0) return;

  const created = runLayoutCommand(
    herdr,
    ["tab", "create", "--workspace", tab.workspaceId, "--no-focus"],
    true,
  );
  const stagingTabId = parseHerdrTabId(created);
  const stagingRootPaneId = parseHerdrRootPaneId(created);
  if (!stagingTabId || !stagingRootPaneId) {
    throw new WorkflowPaneLayoutError("herdr tab create returned invalid JSON");
  }

  // Do not defensively run `pane zoom --off` here: Herdr 0.7.1 focuses an explicitly targeted
  // pane even when it is already unzoomed. Every mutation in this staged rebuild must stay no-focus.
  for (const paneId of plan.stagingPaneIds) {
    runLayoutCommand(herdr, [
      "pane",
      "move",
      paneId,
      "--tab",
      stagingTabId,
      "--split",
      "down",
      "--target-pane",
      stagingRootPaneId,
      "--ratio",
      "0.5",
      "--no-focus",
    ]);
  }
  for (const placement of plan.placements) {
    runLayoutCommand(herdr, [
      "pane",
      "move",
      placement.paneId,
      "--tab",
      tab.tabId,
      "--split",
      placement.split,
      "--target-pane",
      placement.targetPaneId,
      "--ratio",
      String(placement.ratio),
      "--no-focus",
    ]);
  }
  runLayoutCommand(herdr, ["tab", "close", stagingTabId]);
}
