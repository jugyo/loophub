// Example step prompts for the PEVR workflow create form (#1006). These are illustrative
// user-configured prompts — the additive per-step guidance a user writes on top of the fixed
// step contract (core/pevr/contracts/*.md), NOT the contract itself. The Settings "Workflows"
// create form prefills its fields with these so a new workflow starts from a sensible template
// instead of blank textareas. They are a pure constant on purpose: the design (§5.3) requires
// prefilling from a constant rather than seeding a DB row, so an empty install has no workflows
// until the user creates one. Kept free of node/db imports so the web bundle can import it directly.

export interface PevrExamplePrompts {
  description: string;
  plan_prompt: string;
  execute_prompt: string;
  verify_prompt: string;
  reflect_prompt: string;
}

export const PEVR_EXAMPLE_PROMPTS: PevrExamplePrompts = {
  description: "Fixed Plan/Execute/Verify/Reflect development workflow.",
  plan_prompt:
    "Read the task and the code paths it touches before planning. Choose the smallest change " +
    "that satisfies the acceptance criteria, list the files or areas you will edit, and call out " +
    "any risky or ambiguous parts explicitly.",
  execute_prompt:
    "Implement the plan. Match the surrounding code's naming, types, tests, and style, and keep " +
    "the change focused — do not refactor unrelated code. Commit with a concise outcome message.",
  verify_prompt:
    "Run the repository's standard test and lint commands. Walk each acceptance criterion and " +
    "confirm it is met. Report any failure with the exact command and its output rather than a summary.",
  reflect_prompt:
    "Summarize what changed and why, note anything intentionally left out of scope, and record " +
    "follow-ups that deserve a separate issue.",
};
