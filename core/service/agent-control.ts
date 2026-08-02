import type { AgentControl, AgentExecutionTarget } from "../agent-control.ts";
import { ServiceError } from "../errors.ts";
import {
  assertHerdrExecutionTarget,
  herdrAgentControl,
} from "./herdr-agent-control.ts";

export function assertAgentExecutionTarget(target: AgentExecutionTarget): void {
  if (target.provider === "herdr") {
    assertHerdrExecutionTarget(target);
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
  return herdrAgentControl(cwd);
}
