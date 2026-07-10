import { group } from "./args.ts";

export function usage(): void {
  console.log(`lh — LoopHub CLI

  lh info [--json]                                 # resolved env: baseUrl (Web UI), home, dbPath
  lh build <owner>/<repo>/<id> | <id> [--repo owner/name] [--new-attempt] [--claude-code | --codex] [--model <name>] [--sandbox [--allow d1,d2]] [--auto] [--verbose] [--herdr] [--force]   # start one issue in an interactive agent session (--new-attempt: open another draft PR from the existing attempt's fork commit; --claude-code: Claude Code, the default; --codex: Codex instead; --model: session model, passed through to the claude/codex CLI verbatim, defaults to the configured per-agent model when omitted; --auto: auto mode without the sandbox (claude-code: --permission-mode auto; codex: --dangerously-bypass-approvals-and-sandbox); --herdr: after setup, hand off to a herdr pane instead of blocking this process; --force: launch even if another session holds it)
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
  lh inbox send --from '<json>' --title <text> --body <text|-> [--to '<json>'] [--label <name>] [--repo owner/repo]   # send a human-facing Inbox message
  lh inbox read|unread|archive|unarchive|delete <message-id> [--json]   # update an Inbox message state (delete is a soft state)
  lh notification send --kind merge_ready|over_budget|human_attention --title <text> --body <text|-> [--resource repo|issue:<n>|pull:<n>] [--herdr-pane-id <id>] [--source-key <key>] [--repo owner/repo]   # send a topbar notification
  lh workflow list|view|create|update|delete <name> [--description <text>] [--plan-prompt <text>] [--execute-prompt <text>] [--verify-prompt <text>] [--reflect-prompt <text>] [--step plan|execute|verify|reflect --file <path|->]   # manage global workflow prompt bundles
  lh workflow step output [--repo owner/name] [--run <id>] [--step plan|execute|verify|reflect] [--file <path|->]
  lh workflow step input <run> <step> [--repo owner/name] [--note <text|->]   # dry-run the composed contract + inputs + prompt for a step (no launch)
  lh workflow step status <run> [--repo owner/name] [--json]   # evaluate each step's completion (placed artifacts + current head) and latest verdict
  lh handoff record --phase <p> --dir <down|up> (--pr <m> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>]   # record an orchestrator<->subagent handoff (PR + session)
  lh handoff list [--pr <m>] [--issue <n>] [--session <id>] [--json]   # list handoffs for a ref, chronological
  lh retro create --pr <m> --input <file|-> [--status draft]   # save a generated retrospective (rubric+findings) for a PR
  lh retro list [--pr <m>] [--status draft]   lh retro view <id>   lh retro pending [--limit N]   # read retros / list merged PRs without one
  lh worktree prune [--repo owner/name] [--dry-run] [--yes]   # GC done lh-build worktrees (issue closed / PR merged, clean tree)
  lh herdr [--repo owner/name] [--json]                      # show the repo's herdr session as workspace -> tab -> agent(PR)
  lh herdr focus <pr> [--repo owner/name]                     # focus the pane of the running agent for that PR's worktree
  lh attachment add --file <path> [--file <path> ...] [--actor name]   # upload image(s), print embed markdown
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--order asc|desc] [--follow|-f]   # --follow: tail the SSE feed (replay matching, then live; Ctrl-C to stop). --order applies to the snapshot only (a live tail is always chronological)

  common: --session-id <uuid>  --json
  examples:
    lh build 42
    lh build 42 --new-attempt       # open an additional attempt from the first PR's fork commit
    lh build jugyo/loophub/42        # owner/repo/id form: start from outside the repo, no --repo needed
    lh build --sandbox 42            # boolean flags and the issue id may appear in any order
    lh build --auto 42               # auto mode (--permission-mode auto) without the sandbox
    lh build --codex 42              # same worktree/PR/session preparation, but launch Codex instead of Claude Code
    lh build --codex --auto 42       # Codex's auto-mode equivalent (--dangerously-bypass-approvals-and-sandbox)
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue create --title "do the thing" --label ready-to-build [--target-branch integration]
    lh pr create --head feature-x --base main --title "impl" --issue 5 [--draft]
    lh pr comment 3 --body "starting work"
    lh inbox send --from '{"kind":"agent","repo":"me/proj","actor":"impl-bot"}' --title "Needs review" --body "PR is ready" --repo me/proj
    lh notification send --repo me/proj --kind human_attention --title "Needs review" --body "PR is ready" --resource pull:3
    lh inbox archive 12
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
