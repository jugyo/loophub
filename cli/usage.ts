import { group } from "./args.ts";

export function usage(): void {
  console.log(`lh — LoopHub CLI

  lh info [--json]                                 # resolved env: baseUrl (Web UI), home, dbPath
  lh dev <owner>/<repo>/<id> | <id> [--repo owner/name] [--claude-code | --codex] [--model <name>] [--sandbox [--allow d1,d2]] [--auto] [--verbose] [--herdr] [--force]   # start one issue in an interactive agent session (--claude-code: Claude Code, the default; --codex: Codex instead; --model: session model, passed through to the claude/codex CLI verbatim, defaults to the configured per-agent model when omitted; --auto: auto mode without the sandbox (claude-code: --permission-mode auto; codex: --dangerously-bypass-approvals-and-sandbox); --herdr: after setup, hand off to a herdr pane instead of blocking this process; --force: launch even if another session holds it)
  lh resume <owner>/<repo>/<pr> | <pr> [--repo owner/name]   # re-enter the Claude session a PR was developed in (claude --resume in its worktree)
  lh repo add <path> [--name owner/repo]
  lh repo list [--archived false|true|all]
  lh repo archive <owner/repo>   lh repo unarchive <owner/repo>
  lh repo favorite <owner/repo>   lh repo unfavorite <owner/repo>
  lh repo update --repo owner/name [--default-branch main] [--path /abs/path]
  lh repo remove --repo owner/name
  lh session register --id <uuid> --agent <kind> --session <runtime-id> [--name "..."] [--runtime claude-code] [--kind dev|review|issue-create]
  lh session list
  lh session usage [confirm] [--session <id>] [--json]
  lh session usage sync [--session <id>] [--full] [--json]
  lh session usage recalculate [--session <id>] [--json]
  lh issue list|view|create|import|update|comment|close|label  [--repo owner/repo]
  lh issue import <github-issue-url> [--repo owner/repo]   # copy a GitHub issue's title/body into a new loophub issue and link it (requires gh)
  lh pr list|view|diff|create|update|comment|merge|review|ready-for-review|close|reopen  [--repo owner/repo]
  lh handoff record --phase <p> --dir <down|up> (--pr <m> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>]   # record an orchestrator<->subagent handoff (PR + session)
  lh handoff list [--pr <m>] [--issue <n>] [--session <id>] [--json]   # list handoffs for a ref, chronological
  lh retro create --pr <m> --input <file|-> [--status draft]   # save a generated retrospective (rubric+findings) for a PR
  lh retro list [--pr <m>] [--status draft]   lh retro view <id>   lh retro pending [--limit N]   # read retros / list merged PRs without one
  lh worktree prune [--repo owner/name] [--dry-run] [--yes]   # GC done lh-dev worktrees (issue closed / PR merged, clean tree)
  lh herdr [--repo owner/name] [--json]                      # show the repo's herdr session as workspace -> tab -> agent(PR)
  lh herdr focus <pr> [--repo owner/name]                     # focus the pane of the running agent for that PR's worktree
  lh attachment add --file <path> [--file <path> ...] [--actor name]   # upload image(s), print embed markdown
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--order asc|desc] [--follow|-f]   # --follow: tail the SSE feed (replay matching, then live; Ctrl-C to stop). --order applies to the snapshot only (a live tail is always chronological)

  common: --session-id <uuid>  --json
  examples:
    lh dev 42
    lh dev jugyo/loophub/42        # owner/repo/id form: start from outside the repo, no --repo needed
    lh dev --sandbox 42            # boolean flags and the issue id may appear in any order
    lh dev --auto 42               # auto mode (--permission-mode auto) without the sandbox
    lh dev --codex 42              # same worktree/PR/session preparation, but launch Codex instead of Claude Code
    lh dev --codex --auto 42       # Codex's auto-mode equivalent (--dangerously-bypass-approvals-and-sandbox)
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue create --title "do the thing" --label ready-to-build
    lh pr create --head feature-x --base main --title "impl" --issue 5 [--draft]
    lh pr comment 3 --body "starting work"
    lh pr merge 3 --method squash
    lh pr review 3 --event request_changes --body "please fix" --comments review.json
    lh pr review 3 --topic security --event pass --body "no issues found"
    echo '[{"path":"a.txt","line":2,"body":"typo"}]' | lh pr review 3 --comments -
    lh attachment add --file shot.png        # prints ![shot.png](/attachments/<sha256>)
    lh events --since 0
    lh events --follow                 # tail events live (Ctrl-C to stop)
    lh events -f --repo me/proj --json # live NDJSON for one repo`);
  process.exit(group ? 1 : 0);
}
