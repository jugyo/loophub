import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// LoopHub runs either from this checkout (`bun cli/index.ts`) or from the single binary
// `bun build --compile` produces. The binary serves its own modules from Bun's virtual filesystem
// root, so a module URL under /$bunfs/ is how a process tells the two apart. Everything that
// resolves a path relative to the source tree — re-running the CLI, locating the built SPA — has
// to ask this first, because inside the binary there is no source tree to resolve against.
const COMPILED_MODULE_ROOT = "/$bunfs/";

export function isCompiledBinary(): boolean {
  return import.meta.url.includes(COMPILED_MODULE_ROOT);
}

/**
 * The command that re-enters this program's `lh` CLI, as `[command, ...args]` with the caller's
 * arguments appended. The binary dispatches on its first argument (see bin/loophub.ts); the
 * checkout runs the CLI entry point through Bun. Do not inherit process.execPath for a checkout:
 * lh-web can have been started through a Node-based TypeScript loader, which cannot load
 * Bun-only modules such as bun:sqlite.
 */
export function selfCliCommand(): { command: string; args: string[] } {
  if (isCompiledBinary()) return { command: process.execPath, args: ["lh"] };
  return {
    command: "bun",
    args: [fileURLToPath(new URL("../cli/index.ts", import.meta.url))],
  };
}

/**
 * Directory holding the built SPA. Inside the binary the assets are not embedded, so they are
 * expected next to the executable (`<binary dir>/web/dist`); LOOPHUB_WEB_DIST overrides both.
 */
export function webDistDir(): string {
  const override = process.env.LOOPHUB_WEB_DIST?.trim();
  if (override) return override;
  if (isCompiledBinary()) return join(dirname(process.execPath), "web", "dist");
  return fileURLToPath(new URL("../web/dist", import.meta.url));
}
