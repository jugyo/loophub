import { CODING_AGENTS, type CodingAgent } from "../../core/runtimes.ts";
import { flags, sub } from "../args.ts";
import { fail, out } from "../context.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  if (sub !== "install") {
    usage();
    return;
  }
  const scope = flags.scope ?? "user";
  if (scope !== "user" && scope !== "project")
    fail(`unknown scope: ${scope} (expected "user" or "project")`);

  // The target is always named explicitly: installing into a runtime nobody asked for would
  // create its config directory on a machine that never runs it.
  const named = flags.runtime as CodingAgent | undefined;
  const allRuntimes = flags.all === true;
  if (named && allRuntimes) fail("--runtime and --all cannot be combined");
  if (!named && !allRuntimes)
    fail(
      `specify --runtime <id> or --all (runtimes: ${CODING_AGENTS.join(", ")})`,
    );
  if (named && !CODING_AGENTS.includes(named))
    fail(`unknown runtime: ${named} (expected ${CODING_AGENTS.join(", ")})`);
  const runtime = allRuntimes ? ("all" as const) : (named as CodingAgent);

  const { installSkill } = await import("../../core/skill.ts");
  let result: Awaited<ReturnType<typeof installSkill>>;
  try {
    result = await installSkill({ scope, cwd: process.cwd(), runtime });
  } catch (e: any) {
    fail(e?.message ?? String(e));
  }
  if (flags.json) out(result);
  else {
    // One path per line, then a summary naming the runtimes rather than repeating the paths. Both
    // go to stdout like the other success output in `lh` (#558): on stderr the summary reads as a
    // failure in a terminal. A script that wants the paths alone uses --json.
    for (const install of result.installs) console.log(install.path);
    const runtimes = result.installs.flatMap((install) => install.runtimes);
    console.log(
      `installed the LoopHub skill for ${runtimes.join(", ")} (${scope} scope, ${result.bytes} bytes)`,
    );
  }
}
