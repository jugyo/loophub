import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { agentEffort, agentModel } from "../../core/config.ts";
import { ENV_PARENT_ISSUE, ENV_WORKSPACE } from "../../core/environment.ts";
import {
  ENV_ISSUE_CREATE_SESSION,
  LH_ISSUE_CREATE_SESSION_AGENT,
  SESSION_KIND_ISSUE_CREATE,
} from "../../core/session-runtime.ts";
import { issueCreatePrompt } from "../../core/workflow/issue-create-prompt.ts";
import { flags, rest, sub } from "../args.ts";
import {
  display,
  fail,
  out,
  relativeTime,
  resolveRepo,
  run as runOp,
  svc,
  writeSession,
} from "../context.ts";
import {
  buildRuntimeLaunch,
  formatSpawnCommand,
  resolveDevRuntime,
} from "../dev.ts";
import { currentHerdrPaneContext } from "../herdr-context.ts";
import { readTextInput } from "../text-input.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  // Fail-fast runtime validation: conflicting runtime flags and a value-less
  // --model / --effort must fail before svc() opens/migrates the DB or any session/spawn side effect
  // occurs. The real default runtime comes from the repo's effective Coding agent config after the
  // DB is open (#1534); this early pass only rejects mutually exclusive flags.
  if (sub === "new") {
    try {
      resolveDevRuntime({
        claudeCode: flags["claude-code"] === true,
        codex: flags.codex === true,
        grok: flags.grok === true,
        opencode: flags.opencode === true,
      });
    } catch (e: any) {
      fail(e.message);
    }
    if (flags.model !== undefined && typeof flags.model !== "string") {
      fail(`--model requires a value`);
    }
    if (flags.effort !== undefined && typeof flags.effort !== "string") {
      fail(`--effort requires a value`);
    }
    if (flags.prompt !== undefined && typeof flags.prompt !== "string") {
      fail(`--prompt requires a value`);
    }
  }

  const s = await svc();
  const repo = await resolveRepo();
  if (sub === "search") {
    const query = rest.join(" ").trim();
    if (!query)
      fail("usage: lh issue search <query> [--repo owner/name] [--json]");
    const results = await runOp(() => s.search.query(repo, query));
    if (flags.json) {
      out(results);
    } else if (results.length === 0) {
      console.log("No results.");
    } else {
      for (const result of results) {
        console.log(
          `${result.kind}\t#${result.number}\t${result.state}\t${display(result.title)}`,
        );
      }
    }
  } else if (sub === "list") {
    const state = flags.state || "open";
    const items = await s.issues.list(repo, { state });
    const issues = items.filter((i: any) => !i.pull_request);
    out(issues);
    if (!flags.json) {
      const summaries = s.issues.subIssueSummaries(
        repo,
        issues.map((issue: any) => issue.number),
      );
      let hasSubIssues = false;
      issues.forEach((i: any) => {
        const labels = (i.labels || []).map((l: any) => l.name).join(",");
        const summary = summaries.get(i.number);
        const suffix = summary?.total
          ? `\tsub ${summary.closed}/${summary.total}`
          : "";
        hasSubIssues ||= Boolean(summary?.total);
        console.log(
          `#${i.number}\t${i.state}\t${i.title}\t${labels}\t${relativeTime(i.updated_at)}${suffix}`,
        );
      });
      if (hasSubIssues)
        console.log("use 'lh issue sub list <n>' to see sub issues");
    }
  } else if (sub === "view") {
    // Archived comments stay out of `comment_list` unless asked for (#2494), so a reader gets the
    // comments still in play rather than the ones a human already retired.
    const i = await runOp(() =>
      s.issues.get(repo, Number(rest[0]), {
        includeArchivedComments: flags["include-archived"] === true,
      }),
    );
    out(i);
    if (!flags.json) {
      const hierarchy = await runOp(() =>
        s.issues.hierarchy(repo, Number(rest[0])),
      );
      let line = `#${i.number} ${i.title} [${i.state}] @${i.user.login}`;
      if (i.linked_pull_request) {
        const pr = i.linked_pull_request;
        line += `\nlinked PR #${pr.number} (${pr.merged ? "merged" : pr.state})`;
      }
      if (hierarchy.parents.length > 0) {
        line += `\nParent: ${hierarchy.parents.map((parent) => `#${parent.number}`).join(" › ")}`;
      }
      let text = `${line}\n\n${i.body}`;
      if (hierarchy.children.length > 0) {
        text += `\n\nSub issues\n${hierarchy.children
          .map((child) => `#${child.number} [${child.state}] ${child.title}`)
          .join("\n")}`;
      }
      console.log(text);
    }
  } else if (sub === "sub") {
    const action = rest[0];
    if (action === "list") {
      const parent = Number(rest[1]);
      if (!rest[1]) fail("usage: lh issue sub list <parent>");
      const items = await runOp(() => s.issues.listSubIssues(repo, parent));
      out(items);
      if (!flags.json) {
        items.forEach((item: any) => {
          console.log(`#${item.number}\t${item.state}\t${item.title}`);
        });
      }
    } else if (action === "add") {
      if (!rest[1] || !rest[2])
        fail("usage: lh issue sub add <parent> <child>");
      const item = await runOp(async () =>
        s.issues.attachSubIssue(
          repo,
          Number(rest[1]),
          Number(rest[2]),
          await writeSession(),
        ),
      );
      out(item);
      if (!flags.json) console.log(`added #${item.number} as a sub issue`);
    } else if (action === "remove") {
      if (!rest[1]) fail("usage: lh issue sub remove <child>");
      const item = await runOp(async () =>
        s.issues.detachSubIssue(repo, Number(rest[1]), await writeSession()),
      );
      out(item);
      if (!flags.json) console.log(`removed #${item.number} from its parent`);
    } else if (action === "reorder") {
      if (!rest[1] || typeof flags.order !== "string")
        fail("usage: lh issue sub reorder <parent> --order <child,...>");
      const order = flags.order.split(",").map((value) => Number(value.trim()));
      const items = await runOp(async () =>
        s.issues.reorderSubIssues(
          repo,
          Number(rest[1]),
          order,
          await writeSession(),
        ),
      );
      out(items);
      if (!flags.json) console.log(`reordered sub issues for #${rest[1]}`);
    } else {
      fail(
        "usage: lh issue sub list <parent> | add <parent> <child> | remove <child> | reorder <parent> --order <child,...>",
      );
    }
  } else if (sub === "new") {
    // `lh issue new` files an issue *with an AI session* (#299): it launches the configured
    // coding-agent runtime (#658), records the session as kind=issue-create, and later links it
    // to the created issue. The New Issue button supplies localized instructions via --prompt;
    // direct CLI launches fall back to the shared English filing prompt.
    // Same launch shape as a dev session: register the session, then spawn the resolved runtime —
    // here in the repo root (no worktree; filing an issue does not touch a branch).
    //
    // Defaults come from the repo's effective Coding agent config (#1532/#1534) — the same
    // `repos.agentConfig` path `lh workflow start` uses. Explicit --claude-code / --codex /
    // --grok / --model / --effort still override for this launch only.
    const r = await runOp(() => s.repos.get(repo));
    const agentCfg = await runOp(() => s.repos.agentConfig(repo));
    const sessionId = randomUUID();
    const parentIssue =
      flags.parent === undefined ? undefined : Number(flags.parent);
    if (
      parentIssue !== undefined &&
      (!Number.isInteger(parentIssue) || parentIssue < 1)
    ) {
      fail("--parent requires a positive issue number");
    }
    const slashCommand =
      typeof flags.prompt === "string" && flags.prompt.trim()
        ? flags.prompt
        : issueCreatePrompt("en", parentIssue);
    const runtime = resolveDevRuntime({
      claudeCode: flags["claude-code"] === true,
      codex: flags.codex === true,
      grok: flags.grok === true,
      opencode: flags.opencode === true,
      defaultRuntime: agentCfg.effective.runtime,
    });
    const model =
      typeof flags.model === "string" && flags.model.trim()
        ? flags.model
        : runtime === agentCfg.effective.runtime
          ? agentCfg.effective.model
          : agentModel(runtime);
    const effort =
      typeof flags.effort === "string" && flags.effort.trim()
        ? flags.effort.trim()
        : runtime === agentCfg.effective.runtime
          ? agentCfg.effective.effort
          : agentEffort(runtime);
    const { bin: runtimeBin, args: runtimeArgs } = buildRuntimeLaunch({
      runtime,
      sessionId,
      slashCommand,
      sessionName: `New issue (${r.full_name})`,
      model,
      effort,
    });
    await runOp(() =>
      s.sessions.register({
        id: sessionId,
        agent: LH_ISSUE_CREATE_SESSION_AGENT,
        session: sessionId,
        runtime,
        kind: SESSION_KIND_ISSUE_CREATE,
        name: `New issue (${r.full_name})`,
        model,
      }),
    );
    console.error(
      formatSpawnCommand(runtimeArgs, {
        color: process.stderr.isTTY === true,
        bin: runtimeBin,
      }),
    );
    // Carry the session id into the spawned runtime via env. A `lh issue create` run inside the
    // session reads it and links the session to whatever issue it files (the number is unknown
    // here, so the link is recorded after creation — see the create branch below).
    const proc = spawnSync(runtimeBin, runtimeArgs, {
      stdio: "inherit",
      cwd: r.local_path,
      env: {
        ...process.env,
        [ENV_ISSUE_CREATE_SESSION]: sessionId,
        ...(typeof flags["target-branch"] === "string"
          ? {
              [ENV_WORKSPACE]: flags["target-branch"],
            }
          : {}),
        ...(parentIssue !== undefined
          ? { [ENV_PARENT_ISSUE]: String(parentIssue) }
          : {}),
      },
    });
    if (proc.error) {
      const err = proc.error as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        fail(
          `failed to launch ${runtimeBin}: '${runtimeBin}' not found on PATH`,
        );
      }
      fail(`failed to launch ${runtimeBin}: ${err.message}`);
    }
    if (proc.signal) {
      fail(
        `failed to launch ${runtimeBin}: terminated by signal ${proc.signal}`,
      );
    }
    process.exit(proc.status ?? 1);
  } else if (sub === "create") {
    if (
      (flags as Record<string, string | boolean | string[] | undefined>)[
        "create-target-branch"
      ] !== undefined
    ) {
      fail("unknown option: --create-target-branch");
    }
    if (flags.workspace !== undefined && typeof flags.workspace !== "string") {
      fail("--workspace requires a value");
    }
    if (
      typeof flags.workspace === "string" &&
      typeof flags["target-branch"] === "string"
    ) {
      fail("--workspace cannot be combined with --target-branch");
    }
    const labels = (flags.label || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    // Repeatable --ac supplies structured acceptance criteria (#1894), in order; blanks are dropped
    // by the service. This is the concrete AC input path an agent (skill or --prompt) drives.
    const acceptanceCriteria = (flags.ac ?? [])
      .map((x) => x.trim())
      .filter(Boolean);
    const body =
      flags.body === undefined ? undefined : await readTextInput(flags.body);
    const parent =
      flags.parent === undefined
        ? process.env[ENV_PARENT_ISSUE] === undefined
          ? undefined
          : Number(process.env[ENV_PARENT_ISSUE])
        : Number(flags.parent);
    if (parent !== undefined && (!Number.isInteger(parent) || parent < 1)) {
      fail("--parent requires a positive issue number");
    }
    const i = await runOp(async () =>
      s.issues.create(
        repo,
        {
          title: flags.title ?? "",
          body: body || "",
          labels,
          acceptance_criteria: acceptanceCriteria,
          parent,
          workspace: flags.workspace,
          target_branch:
            flags.workspace === undefined
              ? (flags["target-branch"] ?? process.env[ENV_WORKSPACE])
              : undefined,
        },
        await writeSession(),
        currentHerdrPaneContext(),
      ),
    );
    out(i);
    if (!flags.json) console.log(`created #${i.number}`);
    // When this create runs inside a `lh issue new` AI session, link that session to the issue
    // it just filed (#299) so it appears in the issue's related-sessions list.
    // Best-effort: a link failure must not fail the create the user asked for.
    const createSession = process.env[ENV_ISSUE_CREATE_SESSION];
    if (createSession) {
      try {
        await s.sessions.link(repo, {
          sessionId: createSession,
          issue: i.number,
        });
      } catch (e: any) {
        console.error(
          `warning: could not link issue-create session: ${e.message}`,
        );
      }
    }
  } else if (sub === "import") {
    // #614: import a GitHub issue into the resolved repo, copying title/body verbatim and recording
    // the GitHub source link. The repo is the destination (from --repo or cwd); the argument is the
    // GitHub issue URL. Core does the parse → fetch (gh) → create → link work.
    const url = rest[0];
    if (!url) fail("usage: lh issue import <github-issue-url>");
    const i = await runOp(async () =>
      s.issues.import(repo, { url }, await writeSession()),
    );
    out(i);
    if (!flags.json)
      console.log(`imported #${i.number} from ${i.github_issue!.url}`);
  } else if (sub === "update") {
    const patch: {
      title?: string;
      body?: string;
      workspace?: string;
      target_branch?: string | null;
    } = {};
    if (flags.title !== undefined) patch.title = flags.title;
    if (flags.body !== undefined) patch.body = await readTextInput(flags.body);
    if (flags.workspace !== undefined && typeof flags.workspace !== "string")
      fail("--workspace requires a value");
    if (flags.workspace !== undefined && flags["clear-workspace"])
      fail("--workspace cannot be combined with --clear-workspace");
    if (flags.workspace !== undefined && flags["target-branch"] !== undefined)
      fail("--workspace cannot be combined with --target-branch");
    if (flags["clear-workspace"] && flags["target-branch"] !== undefined)
      fail("--clear-workspace cannot be combined with --target-branch");
    if (flags.workspace !== undefined) patch.workspace = flags.workspace;
    if (flags["clear-workspace"]) patch.target_branch = null;
    if (flags["target-branch"] !== undefined)
      patch.target_branch = flags["target-branch"];
    if (Object.keys(patch).length === 0)
      fail("--title and/or --body is required");
    const i = await runOp(async () =>
      s.issues.update(repo, Number(rest[0]), patch, await writeSession()),
    );
    out(i);
    if (!flags.json) console.log(`updated #${i.number}`);
  } else if (sub === "comment") {
    // Write commands return the resource they created/updated so an agent can verify from the
    // output what actually happened, instead of trusting a fixed success word (#1863).
    if (rest[0] === "archive" || rest[0] === "unarchive") {
      if (!flags.issue) fail("--issue is required");
      const archived = rest[0] === "archive";
      const c = await runOp(() =>
        s.comments.setArchived(
          repo,
          Number(flags.issue),
          Number(rest[1]),
          archived,
        ),
      );
      out(c);
      if (!flags.json)
        console.log(
          `${archived ? "archived" : "unarchived"} issue comment ${c.id}`,
        );
    } else {
      const number = Number(rest[0]);
      const body =
        flags.body === undefined ? "" : await readTextInput(flags.body);
      const c = await runOp(async () =>
        s.comments.create(repo, number, body, await writeSession()),
      );
      out(c);
      if (!flags.json)
        console.log(
          `commented on #${number} (comment ${c.id} by @${c.user.login})`,
        );
    }
  } else if (sub === "close") {
    const number = Number(rest[0]);
    const before = await runOp(() => s.issues.get(repo, number));
    const i = await runOp(async () =>
      s.issues.update(repo, number, { state: "closed" }, await writeSession()),
    );
    out(i);
    if (!flags.json)
      console.log(
        before.state === "closed"
          ? `#${i.number} was already closed (no change)`
          : `closed #${i.number} (${before.state} -> ${i.state})`,
      );
  } else if (sub === "label") {
    const number = Number(rest[0]);
    const labels = (flags.add || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    if (labels.length === 0) fail("--add is required");
    const before = await runOp(() => s.issues.get(repo, number));
    const applied = await runOp(async () =>
      s.issues.addLabels(repo, number, labels, await writeSession()),
    );
    out(applied);
    if (!flags.json) {
      const had = new Set((before.labels || []).map((l: any) => l.name));
      const added = labels.filter((l) => !had.has(l));
      const names = applied.map((l: any) => l.name).join(", ");
      console.log(
        added.length === 0
          ? `#${number} already had ${labels.join(", ")} (no change) — labels: ${names}`
          : `labeled #${number} (added: ${added.join(", ")}) — labels: ${names}`,
      );
    }
  } else if (sub === "ac") {
    // Structured acceptance criteria authoring (#1894). No delete command — an unwanted criterion is
    // disabled (its row and future grades survive). Public ids use `<issue>-<ac>`; the issue-scoped
    // `ac-<number>` shorthand remains accepted by mutation commands.
    const action = rest[0];
    if (action === "list") {
      const number = Number(rest[1]);
      const items = await runOp(() => s.issues.acList(repo, number));
      out(items);
      if (!flags.json)
        items.forEach((c: any) => {
          console.log(
            `${c.id}\t${c.ordinal}\t${c.enabled ? "enabled" : "disabled"}\t${c.text}`,
          );
        });
    } else if (action === "add") {
      const number = Number(rest[1]);
      const text =
        flags.text === undefined ? "" : await readTextInput(flags.text);
      const c = await runOp(() => s.issues.acAdd(repo, number, text));
      out(c);
      if (!flags.json)
        console.log(`added acceptance criterion ${c.id} to issue #${number}`);
    } else if (action === "disable" || action === "enable") {
      const hasIssueContext = rest[2] != null;
      const issueNumber = hasIssueContext ? Number(rest[1]) : undefined;
      const rawRef = hasIssueContext ? rest[2] : rest[1];
      const c = await runOp(() =>
        s.issues.acSetEnabled(
          repo,
          rawRef ?? "",
          action === "enable",
          issueNumber,
        ),
      );
      out(c);
      if (!flags.json)
        console.log(
          `${action}d acceptance criterion ${c.id} (${c.enabled ? "enabled" : "disabled"})`,
        );
    } else if (action === "reorder") {
      const number = Number(rest[1]);
      const orderedRefs = (flags.order ?? "")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      const items = await runOp(() =>
        s.issues.acReorder(repo, number, orderedRefs),
      );
      out(items);
      if (!flags.json)
        console.log(`reordered acceptance criteria for issue #${number}`);
    } else {
      fail(
        "usage: lh issue ac add <issue> --text <text> | list <issue> | disable|enable <issue-ac> | disable|enable <issue> ac-<number> | reorder <issue> --order <issue-ac|ac-number,...>",
      );
    }
  } else usage();
}
