import type { GhCheckRun } from "./github.ts";
import type { GithubConversationThreadWire } from "./serialize.ts";
import { neutralizeWorkflowMentions } from "./workflow/comment-routing.ts";

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function threadSection(thread: GithubConversationThreadWire): string {
  const location = thread.line
    ? `${thread.path}:${thread.line}`
    : (thread.path ?? "(unknown file)");
  const comments = thread.comments.map(
    (comment) => `${comment.author ?? "unknown"}:\n\n${quote(comment.body)}`,
  );
  return [`### ${location}`, ...comments].join("\n\n");
}

function checkLine(check: GhCheckRun): string {
  const name = check.workflow
    ? `${check.workflow} / ${check.name}`
    : check.name;
  return check.url ? `- ${name}: ${check.url}` : `- ${name}`;
}

/**
 * One PR comment asking the agent to fix the selected GitHub feedback. Everything quoted came from
 * GitHub, so the routing mentions in the finished text are neutralized: with none left the comment
 * goes where any plain PR comment goes.
 */
export function githubFixRequestBody(input: {
  threads: GithubConversationThreadWire[];
  checks: GhCheckRun[];
}): string {
  const sections = ["Please fix the following GitHub PR feedback."];
  if (input.threads.length > 0) {
    sections.push("## Review threads", ...input.threads.map(threadSection));
  }
  if (input.checks.length > 0) {
    sections.push("## Failed checks", input.checks.map(checkLine).join("\n"));
  }
  return neutralizeWorkflowMentions(sections.join("\n\n"));
}
