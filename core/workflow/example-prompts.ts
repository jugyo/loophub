// Example step prompts for the workflow create form (#1006). These are illustrative
// user-configured prompts — the additive per-step guidance a user writes on top of the fixed
// step contract (core/workflow/contracts/*.md), NOT the contract itself. The Settings "Workflows"
// create form prefills its fields with these so a new workflow starts from a sensible template
// instead of blank textareas. They are a pure constant on purpose: the workflow definition design
// requires prefilling from a constant rather than seeding a DB row, so an empty install has no workflows
// until the user creates one. Kept free of node/db imports so the web bundle can import it directly.

export interface WorkflowExamplePrompts {
  description: string;
  execute_prompt: string;
  verify_prompt: string;
}

export const WORKFLOW_EXAMPLE_PROMPTS: WorkflowExamplePrompts = {
  description: "Fixed Execute/Verify development workflow.",
  execute_prompt:
    "Read the task and relevant code, make a focused implementation plan, then implement it. " +
    "Match the surrounding naming, types, tests, and style, commit with a concise outcome message, " +
    "and reflect on the work before submitting the execution report.",
  verify_prompt:
    "Run the repository's standard test and lint commands. Walk each acceptance criterion and " +
    "confirm it is met. Report any failure with the exact command and its output rather than a summary.",
};
