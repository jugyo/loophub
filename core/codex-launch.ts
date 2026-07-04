import { configDir } from "./config.ts";

export function buildCodexSandboxArgs(loopHubHome = configDir()): string[] {
  return [
    "--sandbox",
    "workspace-write",
    "-c",
    `sandbox_workspace_write.writable_roots=[${JSON.stringify(loopHubHome)}]`,
  ];
}
