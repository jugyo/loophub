import { resolve } from "node:path";
import { flags, rest, sub } from "../args.ts";
import { fail, out, run as runOp, svc, writeSession } from "../context.ts";
import { usage } from "../usage.ts";

export async function run(): Promise<void> {
  const s = await svc();
  if (sub === "add") {
    const path = resolve(rest[0] || flags.path || process.cwd());
    const name = flags.name || `me/${path.split("/").pop()}`;
    const r = await runOp(() => s.repos.create({ path, name }));
    console.log(`added ${r.full_name}  (${r.local_path})`);
  } else if (sub === "list") {
    // Bare `--archived` resolves to boolean true under strict:false; treat it like the
    // old parser's "true" so `lh repo list --archived` still lists archived repos.
    const archived =
      flags.archived === "true" || flags.archived === true
        ? "archived"
        : flags.archived === "all"
          ? "all"
          : "active";
    const repos = s.repos.list(archived);
    out(repos);
    if (!flags.json)
      repos.forEach((r) => {
        console.log(
          `${r.favorite ? "[favorite] " : ""}${r.archived ? "[archived] " : ""}${r.full_name}\t${r.local_path}`,
        );
      });
  } else if (sub === "archive" || sub === "unarchive") {
    const name = rest[0] || flags.repo;
    if (!name) fail("owner/name is required");
    const r = await runOp(async () =>
      s.repos.setArchived(name, sub === "archive", await writeSession()),
    );
    console.log(`${sub}d ${r.full_name}`);
  } else if (sub === "favorite" || sub === "unfavorite") {
    const name = rest[0] || flags.repo;
    if (!name) fail("owner/name is required");
    const r = await runOp(async () =>
      s.repos.setFavorite(name, sub === "favorite", await writeSession()),
    );
    console.log(`${sub}d ${r.full_name}`);
  } else if (sub === "update") {
    const name = flags.repo || rest[0];
    if (!name)
      fail(
        "usage: lh repo update --repo owner/name [--default-branch main] [--path /abs/path]",
      );
    const fields: { default_branch?: string; local_path?: string } = {};
    if (flags["default-branch"])
      fields.default_branch = flags["default-branch"];
    if (flags.path) fields.local_path = resolve(flags.path);
    if (!fields.default_branch && !fields.local_path)
      fail("at least one of --default-branch or --path is required");
    const r = await runOp(() => s.repos.update(name, fields));
    console.log(
      `updated ${r.full_name}  default_branch=${r.default_branch}  (${r.local_path})`,
    );
  } else if (sub === "remove") {
    const name = flags.repo || rest[0];
    if (!name) fail("usage: lh repo remove --repo owner/name");
    await runOp(() => s.repos.remove(name));
    console.log(`removed ${name}`);
  } else if (sub === "merge-mode") {
    // #406: show or set the repo's PR-detail write action. No mode arg → show the resolved view;
    // a mode arg (merge | github_pr | auto) pins or clears it.
    const name = flags.repo || rest[0];
    if (!name)
      fail(
        "usage: lh repo merge-mode --repo owner/name [merge|github_pr|auto]",
      );
    const mode = (flags.repo ? rest[0] : rest[1]) as
      | "merge"
      | "github_pr"
      | "auto"
      | undefined;
    if (mode) {
      const r = await runOp(async () =>
        s.repos.setMergeMode(name, mode, await writeSession()),
      );
      console.log(`${r.full_name} merge_mode=${r.merge_mode ?? "auto"}`);
    } else {
      const m = await runOp(() => s.repos.mergeMode(name));
      out(m);
      if (!flags.json)
        console.log(
          `setting=${m.setting ?? "auto"}  github_remote=${m.has_github_remote}  effective=${m.effective}`,
        );
    }
  } else usage();
}
