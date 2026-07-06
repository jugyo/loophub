import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { flags, rest, sub } from "../args.ts";
import { fail, out, run as runOp } from "../context.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  if (sub === "add") {
    // Files may be given as repeated --file flags and/or positionals.
    const paths = [...(flags.file ?? []), ...rest];
    if (paths.length === 0)
      fail(
        "usage: lh attachment add --file <path> [--file <path> ...] [--actor name]",
      );
    const { saveAttachment } = await import("../../core/attachments.ts");
    // Standalone blobs aren't attributed to a session; default to the human "me".
    const author = flags.actor || "me";
    for (const p of paths) {
      const abs = resolve(p);
      if (!existsSync(abs)) fail(`file not found: ${p}`);
      const data = readFileSync(abs);
      const filename = abs.split("/").pop() || abs;
      const r = await runOp(() => saveAttachment({ data, filename, author }));
      if (flags.json) out(r);
      else {
        console.log(r.markdown);
        console.error(`uploaded ${filename} → ${r.url} (${r.size} bytes)`);
      }
    }
  } else usage();
}
