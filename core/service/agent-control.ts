import type { AgentControl, AgentExecutionTarget } from "../agent-control.ts";
import { ServiceError } from "../errors.ts";
import {
  HERDR_CORE_PROVIDER,
  isHerdrCoreAddress,
  killHerdrCoreTerminal,
  sendToHerdrCoreTerminal,
} from "../terminal/herdr-core-terminal.ts";
import {
  assertHerdrExecutionTarget,
  herdrAgentControl,
} from "./herdr-agent-control.ts";

export function assertAgentExecutionTarget(target: AgentExecutionTarget): void {
  if (target.provider === "herdr") {
    assertHerdrExecutionTarget(target);
    return;
  }
  if (target.provider === HERDR_CORE_PROVIDER) {
    if (!isHerdrCoreAddress(target.targetId))
      throw new ServiceError(
        422,
        "Agent has no valid herdr-core execution target",
      );
    return;
  }
  throw new ServiceError(
    422,
    `Unsupported agent-control provider "${target.provider}"`,
  );
}

export function agentControl(
  cwd: string,
  target: AgentExecutionTarget,
): AgentControl {
  assertAgentExecutionTarget(target);
  if (target.provider === HERDR_CORE_PROVIDER) {
    return {
      inputText: (t, text) => sendToHerdrCoreTerminal(t.targetId, text),
      close: async (t) => killHerdrCoreTerminal(t.targetId),
    };
  }
  return herdrAgentControl(cwd);
}
