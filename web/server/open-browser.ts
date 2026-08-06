// Opens the lh-web UI in the user's default browser at startup. Best effort by design: the URL is
// already logged, so a failure here is a warning, never a reason to stop serving.
import { spawn } from "node:child_process";

export interface BrowserOpenCommand {
  command: string;
  args: string[];
}

// The platform's "hand this URL to the default handler" command. Pure, so the mapping stays
// testable without spawning anything.
export function browserOpenCommand(
  url: string,
  platform: NodeJS.Platform = process.platform,
): BrowserOpenCommand {
  if (platform === "darwin") return { command: "open", args: [url] };
  // `start` is a cmd builtin whose first quoted argument is the window title; pass an empty title
  // so the URL is not consumed as one.
  if (platform === "win32")
    return { command: "cmd", args: ["/c", "start", "", url] };
  return { command: "xdg-open", args: [url] };
}

// Spawn the opener detached and unref'd: lh-web must not wait on — or be held open by — whatever
// the desktop environment does with the URL.
export function openBrowser(
  url: string,
  onWarn: (message: string) => void,
  platform: NodeJS.Platform = process.platform,
): void {
  const { command, args } = browserOpenCommand(url, platform);
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", (error) => {
    onWarn(`lh-web: could not open ${url} with ${command}: ${error.message}`);
  });
  child.on("exit", (code) => {
    if (code) onWarn(`lh-web: ${command} exited with ${code} opening ${url}`);
  });
  child.unref();
}
