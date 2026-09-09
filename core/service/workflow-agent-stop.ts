import { ServiceError } from "../errors.ts";
import * as S from "../store.ts";
import { killPaneForegroundProcess } from "../terminal/herdr-cleanup.ts";
import { repoOr404 } from "./shared.ts";
import { workflowRunParentPaneId } from "./workflow-panes.ts";

export const workflowAgentStop = {
  async run(
    name: string,
    input: { run: number },
    deps: { killPaneForegroundProcess: typeof killPaneForegroundProcess } = {
      killPaneForegroundProcess,
    },
  ): Promise<{ stopped: number }> {
    const repo = repoOr404(name);
    const run = S.getWorkflowRun(input.run);
    if (!run || run.repo_id !== repo.id) {
      throw new ServiceError(404, `Workflow run #${input.run} not found`);
    }
    const pull = S.getIssue(repo.id, run.pr_number);
    if (pull?.state !== "closed") {
      return { stopped: 0 };
    }

    const paneIds = new Set<string>();
    const parentPaneId = workflowRunParentPaneId(run);
    if (parentPaneId) paneIds.add(parentPaneId);
    if (run.active_session_id) {
      const activeTarget = S.getAgentExecutionTarget(run.active_session_id);
      if (activeTarget?.provider === "herdr")
        paneIds.add(activeTarget.target_id);
    }
    for (const paneId of paneIds) {
      await deps.killPaneForegroundProcess(repo, paneId);
    }
    return { stopped: paneIds.size };
  },
};
