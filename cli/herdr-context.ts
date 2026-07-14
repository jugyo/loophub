import { ENV_ISSUE_CREATE_HERDR_LAUNCH } from "../core/resume.ts";
import type { CurrentHerdrPaneContext } from "../core/service/issues.ts";
import { HERDR_ID } from "../core/terminal/terminal-launch.ts";

export function currentHerdrPaneContext(
  env: Record<string, string | undefined> = process.env,
): CurrentHerdrPaneContext | null {
  if (env.HERDR_ENV !== "1") return null;
  const sessionName = env.HERDR_SESSION;
  const paneId = env.HERDR_PANE_ID;
  const launchId = env[ENV_ISSUE_CREATE_HERDR_LAUNCH];
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
