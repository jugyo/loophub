import { readFileSync } from "node:fs";
import { flags, rest, sub } from "../args.ts";
import {
  fail,
  out,
  readStdin,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import { usage } from "../usage.ts";

type PromptField =
  | "plan_prompt"
  | "execute_prompt"
  | "verify_prompt"
  | "reflect_prompt";
type PromptStep = "plan" | "execute" | "verify" | "reflect";

const STEP_TO_FIELD: Record<PromptStep, PromptField> = {
  plan: "plan_prompt",
  execute: "execute_prompt",
  verify: "verify_prompt",
  reflect: "reflect_prompt",
};

function nameArg(): string {
  const name = rest[0] || flags.name;
  if (!name) fail("workflow name is required");
  return name;
}

async function fileText(path: string): Promise<string> {
  if (path === "-") return readStdin();
  return readFileSync(path, "utf8");
}

async function promptPatchFromFlags(): Promise<
  Partial<Record<PromptField, string>>
> {
  const patch: Partial<Record<PromptField, string>> = {};
  if (flags["plan-prompt"] !== undefined)
    patch.plan_prompt = flags["plan-prompt"];
  if (flags["execute-prompt"] !== undefined)
    patch.execute_prompt = flags["execute-prompt"];
  if (flags["verify-prompt"] !== undefined)
    patch.verify_prompt = flags["verify-prompt"];
  if (flags["reflect-prompt"] !== undefined)
    patch.reflect_prompt = flags["reflect-prompt"];
  if (flags.step !== undefined || flags.file?.[0] !== undefined) {
    if (!flags.step || !flags.file?.[0])
      fail("--step and --file must be provided together");
    if (
      flags.step !== "plan" &&
      flags.step !== "execute" &&
      flags.step !== "verify" &&
      flags.step !== "reflect"
    )
      fail("--step must be one of: plan, execute, verify, reflect");
    patch[STEP_TO_FIELD[flags.step]] = await fileText(flags.file[0]);
  }
  return patch;
}

function printWorkflow(w: {
  id: number;
  name: string;
  description: string;
  plan_prompt: string;
  execute_prompt: string;
  verify_prompt: string;
  reflect_prompt: string;
}) {
  console.log(`#${w.id}\t${w.name}`);
  if (w.description) console.log(`description\t${w.description}`);
  console.log(`plan_prompt\t${w.plan_prompt}`);
  console.log(`execute_prompt\t${w.execute_prompt}`);
  console.log(`verify_prompt\t${w.verify_prompt}`);
  console.log(`reflect_prompt\t${w.reflect_prompt}`);
}

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "list") {
    const workflows = await runOp(() => s.pevrWorkflows.list());
    out(workflows);
    if (!flags.json) {
      for (const w of workflows)
        console.log(`#${w.id}\t${w.name}\t${w.description}`);
    }
  } else if (sub === "view") {
    const workflow = await runOp(() => s.pevrWorkflows.get(nameArg()));
    out(workflow);
    if (!flags.json) printWorkflow(workflow);
  } else if (sub === "create") {
    const promptPatch = await promptPatchFromFlags();
    const workflow = await runOp(async () =>
      s.pevrWorkflows.create(
        {
          name: nameArg(),
          description: flags.description,
          ...promptPatch,
        },
        await writeSession(),
      ),
    );
    if (flags.json) out(workflow);
    else console.log(`created workflow "${workflow.name}" (id ${workflow.id})`);
  } else if (sub === "update") {
    const promptPatch = await promptPatchFromFlags();
    const patch = {
      name: flags.name,
      description: flags.description,
      ...promptPatch,
    };
    if (
      patch.name === undefined &&
      patch.description === undefined &&
      patch.plan_prompt === undefined &&
      patch.execute_prompt === undefined &&
      patch.verify_prompt === undefined &&
      patch.reflect_prompt === undefined
    )
      fail("at least one workflow field must be provided");
    const workflow = await runOp(async () =>
      s.pevrWorkflows.update(nameArg(), patch, await writeSession()),
    );
    if (flags.json) out(workflow);
    else console.log(`updated workflow "${workflow.name}"`);
  } else if (sub === "delete") {
    const name = nameArg();
    const result = await runOp(async () =>
      s.pevrWorkflows.delete(name, await writeSession()),
    );
    if (flags.json) out(result);
    else console.log(`deleted workflow "${name}"`);
  } else usage();
}
