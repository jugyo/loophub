import { existsSync, fstatSync, readFileSync } from "node:fs";
import { readStdin } from "./context.ts";

/**
 * Resolve a free-text CLI value without putting Markdown through a shell.
 * `-` reads stdin and `@path` reads a file; other values stay direct text.
 * A few historical commands also accepted a bare file path, so they can opt in.
 */
export async function readTextInput(
  value: string,
  options: { bareFile?: boolean } = {},
): Promise<string> {
  if (value === "-") return readStdin();
  if (value.startsWith("@") && existsSync(value.slice(1)))
    return readFileSync(value.slice(1), "utf8");
  if (options.bareFile) return readFileSync(value, "utf8");
  return value;
}

/**
 * A free-text body redirected into the command without naming its flag. Only a pipe or a redirected
 * file can carry one; a tty and `/dev/null` are character devices and are never read, so a command
 * run with no redirection cannot block here.
 */
export async function readRedirectedStdin(): Promise<string | null> {
  let redirected: boolean;
  try {
    redirected = !fstatSync(0).isCharacterDevice();
  } catch {
    return null;
  }
  if (!redirected) return null;
  const text = await readStdin();
  return text.trim() ? text : null;
}
