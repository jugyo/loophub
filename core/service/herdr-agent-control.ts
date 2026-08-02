import type { AgentControl, AgentExecutionTarget } from "../agent-control.ts";
import { ServiceError } from "../errors.ts";
import { HERDR_ID } from "../terminal/terminal-launch.ts";
import { sendHerdrPrompt } from "./herdr-prompt.ts";
import { runHerdr } from "./herdr-runner.ts";

const HERDR_TIMEOUT_MS = 15_000;

function address(target: AgentExecutionTarget): {
  paneId: string;
  sessionName: string;
} {
  if (
    target.provider !== "herdr" ||
    !target.context ||
    !HERDR_ID.test(target.targetId)
  ) {
    throw new ServiceError(422, "Agent has no valid Herdr execution target");
  }
  return { paneId: target.targetId, sessionName: target.context };
}

export function assertHerdrExecutionTarget(target: AgentExecutionTarget): void {
  address(target);
}

export function herdrAgentControl(cwd: string): AgentControl {
  const run = async (
    target: AgentExecutionTarget,
    operation: string,
    args: string[],
  ) => {
    const { paneId, sessionName } = address(target);
    await runHerdr(
      "herdr",
      ["--session", sessionName, "pane", operation, paneId, ...args],
      cwd,
      { timeoutMs: HERDR_TIMEOUT_MS },
    );
  };
  return {
    inputText: (target, text) => {
      const { paneId, sessionName } = address(target);
      return sendHerdrPrompt({
        sessionName,
        paneId,
        text,
        cwd,
        timeoutMs: HERDR_TIMEOUT_MS,
      });
    },
    inputKey: (target, key) => run(target, "send-keys", [key]),
    close: (target) => run(target, "close", []),
  };
}
