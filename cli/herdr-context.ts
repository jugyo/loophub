import type { CurrentHerdrPaneContext } from "../core/service/issues.ts";
import { ENV_ISSUE_CREATE_HERDR_LAUNCH } from "../core/session-runtime.ts";
import {
  HERDR_CORE_SESSION_NAME,
  isHerdrCoreAddress,
} from "../core/terminal/herdr-core-terminal.ts";
import { HERDR_ID } from "../core/terminal/terminal-launch.ts";

export function currentHerdrPaneContext(
  env: Record<string, string | undefined> = process.env,
): CurrentHerdrPaneContext | null {
  const launchId = env[ENV_ISSUE_CREATE_HERDR_LAUNCH];
  // Checked before HERDR_ENV: a terminal inherits the core's environment, which carries the HERDR_*
  // of whichever pane happened to start the core.
  const terminalId = env.HC_TERMINAL_ID;
  if (terminalId && isHerdrCoreAddress(terminalId)) {
    return {
      sessionName: HERDR_CORE_SESSION_NAME,
      paneId: terminalId,
      ...(launchId && HERDR_ID.test(launchId) ? { launchId } : {}),
    };
  }
  if (env.HERDR_ENV !== "1") return null;
  const sessionName = env.HERDR_SESSION;
  const paneId = env.HERDR_PANE_ID;
  if (
    !sessionName ||
    !HERDR_ID.test(sessionName) ||
    !paneId ||
    !HERDR_ID.test(paneId) ||
    (launchId != null && (!launchId || !HERDR_ID.test(launchId)))
  ) {
    return null;
  }
  return {
    sessionName,
    paneId,
    ...(launchId ? { launchId } : {}),
  };
}
