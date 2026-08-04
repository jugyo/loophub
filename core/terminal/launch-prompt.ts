import { randomUUID } from "node:crypto";
import { ensureHomeDir, writeHomeFile } from "../home-files.ts";

// The prompt file for a launch that has no workflow run to hang it off (New workflow, the GitHub PR
// export). Same rationale as a run's prompt files: the launch types the runtime's command line into
// its pane and the shell reads the prompt back from here, so a multi-KB generated prompt never has
// to be typed into the terminal itself. These launches have no id of their own, so the file is
// named after a fresh uuid.
export function writeLaunchPrompt(text: string): string {
  return writeHomeFile(ensureHomeDir("launches"), `${randomUUID()}.md`, text);
}
