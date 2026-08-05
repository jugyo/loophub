import * as S from "../store.ts";
import { HERDR_ID } from "../terminal/terminal-launch.ts";

/**
 * The Herdr pane a run's parent agent was launched into, as the launch recorded it
 * (`workflowInstructions.registerParentPane`). This one pane is the run's placement anchor: an
 * instruction is injected into it, every child step is created by splitting it, and the run's tab is
 * whichever tab Herdr reports it in. Resolving all of that from the recorded pane — rather than from
 * the `HERDR_PANE_ID` / `HERDR_TAB_ID` of whichever process happens to ask — keeps placement
 * independent of what is focused at launch time.
 *
 * `undefined` means the run has no registered pane at all (its parent was started outside the
 * recorded launch path, or has not finished launching). `null` means a registration exists but is
 * unusable — more than one pane claims the run, or the stored id is missing/malformed — which is a
 * different situation from "not registered yet" and must not be silently read as one.
 */
export function workflowRunParentPaneId(
  run: S.WorkflowRunRow,
): string | null | undefined {
  const matches = S.listHerdrPanesForResource({
    repoId: run.repo_id,
    resourceKind: "workflow_run",
    resourceKey: String(run.id),
  });
  if (matches.length === 0) return undefined;
  const paneId = matches[0].pane_id;
  if (matches.length !== 1 || !paneId) return null;
  return HERDR_ID.test(paneId) ? paneId : null;
}
