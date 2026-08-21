#!/usr/bin/env bun
import { flags, group, pos } from "./args.ts";
import * as attachmentCmd from "./commands/attachment.ts";
import * as eventsCmd from "./commands/events.ts";
import * as handoffCmd from "./commands/handoff.ts";
import * as herdrCmd from "./commands/herdr.ts";
import * as infoCmd from "./commands/info.ts";
import * as issueCmd from "./commands/issue.ts";
import * as notificationCmd from "./commands/notification.ts";
import * as prCmd from "./commands/pr.ts";
import * as repoCmd from "./commands/repo.ts";
import * as retroCmd from "./commands/retro.ts";
import * as sessionCmd from "./commands/session.ts";
import * as syncCmd from "./commands/sync.ts";
import * as workflowCmd from "./commands/workflow.ts";
import * as workspaceCmd from "./commands/workspace.ts";
import * as worktreeCmd from "./commands/worktree.ts";
import { fail } from "./context.ts";
import { printCommandHelp } from "./help.ts";
import { usage } from "./usage.ts";

// ---- dispatch ----
async function main() {
  if (flags.help) {
    if (!printCommandHelp(pos)) usage();
    return;
  }
  if (flags.cursor === true) {
    fail("unknown option: --cursor (Cursor coding-agent support was removed)");
  }
  if (group === "info") return infoCmd.run();
  if (group === "repo") return repoCmd.run();
  if (group === "issue") return issueCmd.run();
  if (group === "session") return sessionCmd.run();
  if (group === "attachment") return attachmentCmd.run();
  if (group === "pr") return prCmd.run();
  if (group === "handoff") return handoffCmd.run();
  if (group === "notification") return notificationCmd.run();
  if (group === "workspace") return workspaceCmd.run();
  if (group === "worktree") return worktreeCmd.run();
  if (group === "herdr") return herdrCmd.run();
  if (group === "retro") return retroCmd.run();
  if (group === "sync") return syncCmd.run();
  if (group === "events") return eventsCmd.run();
  if (group === "workflow") return workflowCmd.run();
  usage();
}

main();
