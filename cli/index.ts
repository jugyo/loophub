import { group } from "./args.ts";
import * as attachmentCmd from "./commands/attachment.ts";
import * as buildCmd from "./commands/build.ts";
import * as eventsCmd from "./commands/events.ts";
import * as handoffCmd from "./commands/handoff.ts";
import * as herdrCmd from "./commands/herdr.ts";
import * as infoCmd from "./commands/info.ts";
import * as issueCmd from "./commands/issue.ts";
import * as prCmd from "./commands/pr.ts";
import * as repoCmd from "./commands/repo.ts";
import * as resumeCmd from "./commands/resume.ts";
import * as retroCmd from "./commands/retro.ts";
import * as sessionCmd from "./commands/session.ts";
import * as syncCmd from "./commands/sync.ts";
import * as worktreeCmd from "./commands/worktree.ts";
import { usage } from "./usage.ts";

// ---- dispatch ----
async function main() {
  if (group === "info") return infoCmd.run();
  if (group === "build") return buildCmd.run();
  if (group === "resume") return resumeCmd.run();
  if (group === "repo") return repoCmd.run();
  if (group === "issue") return issueCmd.run();
  if (group === "session") return sessionCmd.run();
  if (group === "attachment") return attachmentCmd.run();
  if (group === "pr") return prCmd.run();
  if (group === "handoff") return handoffCmd.run();
  if (group === "worktree") return worktreeCmd.run();
  if (group === "herdr") return herdrCmd.run();
  if (group === "retro") return retroCmd.run();
  if (group === "sync") return syncCmd.run();
  if (group === "events") return eventsCmd.run();
  usage();
}

main();
