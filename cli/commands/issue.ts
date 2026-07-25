import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { agentEffort, agentModel } from "../../core/config.ts";
import { ENV_WORKSPACE } from "../../core/environment.ts";
import {
  ENV_ISSUE_CREATE_SESSION,
  LH_ISSUE_CREATE_SESSION_AGENT,
  SESSION_KIND_ISSUE_CREATE,
} from "../../core/resume.ts";
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
    if (!flags.json)
      issues.forEach((i: any) => {
        const labels = (i.labels || []).map((l: any) => l.name).join(",");
        console.log(
          `#${i.number}\t${i.state}\t${i.title}\t${labels}\t${relativeTime(i.updated_at)}`,
        );
      });
  } else if (sub === "view") {
    const i = await runOp(() => s.issues.get(repo, Number(rest[0])));
    out(i);
    if (!flags.json) {
      let line = `#${i.number} ${i.title} [${i.state}] @${i.user.login}`;
      if (i.linked_pull_request) {
        const pr = i.linked_pull_request;
        line += `\nlinked PR #${pr.number} (${pr.merged ? "merged" : pr.state})`;
      }
      console.log(`${line}\n\n${i.body}`);
    }
  } else if (sub === "new") {
    // `lh issue new` files an issue *with an AI session* (#299): it launches the configured
    // coding-agent runtime (#658), records the session as kind=issue-create, and later links it
    // to the created issue. The New Issue button supplies direct instructions via --prompt; when
    // omitted, the compatibility `/lh-issue-create` skill remains the default.
    // Same launch shape as a dev session: register the session, then spawn the resolved runtime —
    // here in the repo root (no worktree; filing an issue does not touch a branch).
    //
    // Defaults come from the repo's effective Coding agent config (#1532/#1534) — the same
    // `repos.agentConfig` path `lh workflow start` uses. Explicit --claude-code / --codex /
    // --grok / --model / --effort still override for this launch only.
    const r = await runOp(() => s.repos.get(repo));
    const agentCfg = await runOp(() => s.repos.agentConfig(repo));
    const sessionId = randomUUID();
    const slashCommand =
      typeof flags.prompt === "string" && flags.prompt.trim()
        ? flags.prompt
        : "/lh-issue-create";
    const runtime = resolveDevRuntime({
      claudeCode: flags["claude-code"] === true,
      codex: flags.codex === true,
      grok: flags.grok === true,
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
    const i = await runOp(async () =>
      s.issues.create(
        repo,
        {
          title: flags.title ?? "",
          body: flags.body || "",
          labels,
          acceptance_criteria: acceptanceCriteria,
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
    // it just filed (#299) so it appears in the issue's related-sessions list and is resumable.
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
    if (flags.body !== undefined) patch.body = flags.body;
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
    const number = Number(rest[0]);
    const c = await runOp(async () =>
      s.comments.create(repo, number, flags.body ?? "", await writeSession()),
    );
    out(c);
    if (!flags.json)
      console.log(
        `commented on #${number} (comment ${c.id} by @${c.user.login})`,
      );
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
    // disabled (its row and future grades survive). add/list/reorder address the issue by number;
    // disable/enable address a criterion by its stable id.
    const action = rest[0];
    if (action === "list") {
      const number = Number(rest[1]);
      const items = await runOp(() => s.issues.acList(repo, number));
      out(items);
      if (!flags.json)
        items.forEach((c: any) => {
          console.log(
            `#${c.id}\t${c.ordinal}\t${c.enabled ? "enabled" : "disabled"}\t${c.text}`,
          );
        });
    } else if (action === "add") {
      const number = Number(rest[1]);
      const c = await runOp(() =>
        s.issues.acAdd(repo, number, flags.text ?? ""),
      );
      out(c);
      if (!flags.json)
        console.log(`added acceptance criterion #${c.id} to issue #${number}`);
    } else if (action === "disable" || action === "enable") {
      const criterionId = Number(rest[1]);
      const c = await runOp(() =>
        s.issues.acSetEnabled(repo, criterionId, action === "enable"),
      );
      out(c);
      if (!flags.json)
        console.log(
          `${action}d acceptance criterion #${c.id} (${c.enabled ? "enabled" : "disabled"})`,
        );
    } else if (action === "reorder") {
      const number = Number(rest[1]);
      const orderedIds = (flags.order ?? "")
        .split(",")
        .map((x) => Number(x.trim()))
        .filter((n) => Number.isInteger(n));
      const items = await runOp(() =>
        s.issues.acReorder(repo, number, orderedIds),
      );
      out(items);
      if (!flags.json)
        console.log(`reordered acceptance criteria for issue #${number}`);
    } else {
      fail(
        "usage: lh issue ac add <issue> --text <text> | list <issue> | disable|enable <criterion-id> | reorder <issue> --order <id,id,...>",
      );
    }
  } else usage();
}
