import { group } from "./args.ts";

export function usage(): void {
  console.log(`lh — LoopHub CLI

  lh info [--json]                                 # resolved env: baseUrl (Web UI), home, dbPath
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
  lh issue search|list|view|create|import|update|comment|close|label  [--repo owner/repo]
  lh issue search <query> [--repo owner/name] [--json]       # search issues and pull requests in one repository
  lh issue import <github-issue-url> [--repo owner/repo]   # copy a GitHub issue's title/body into a new loophub issue and link it (requires gh)
  lh pr list|view|diff|create|update|comment|merge|review|ready-for-review|crit|close|reopen  [--repo owner/repo]
  lh pr crit <pr> [--repo owner/repo]          # open crit --range <base>..HEAD in the PR worktree (requires crit on PATH)
  lh inbox send --from '<json>' --title <text> --body <text|-> [--to '<json>'] [--label <name>] [--repo owner/repo]   # send a human-facing Inbox message
  lh inbox read|unread|archive|unarchive|delete <message-id> [--json]   # update an Inbox message state (delete is a soft state)
  lh notification send --kind merge_ready|over_budget|human_attention --title <text> --body <text|-> [--resource repo|issue:<n>|pull:<n>] [--herdr-pane-id <id>] [--source-key <key>] [--repo owner/repo]   # send a topbar notification
  lh workspace create|list|archive [<branch>] [--repo owner/name]   # workspace = integration branch; worktree = PR checkout
  lh workflow list|view|create|update|delete <name> [--description <text>] [--execute-prompt <text>] [--verify-prompt <text>] [--step execute|verify --file <path|->]   # manage global workflow prompt bundles
  lh workflow start <owner>/<repo>/<issue> | <issue> [--repo owner/name] (--workflow <name> | --workflow-id <id>) [--claude-code | --codex | --grok] [--model <name>] [--herdr] [--auto] [--no-launch]   # start a Workflow run (default runtime/model from app settings; --auto launches the parent and all step agents in auto mode)
  lh workflow run advance-to-verify|request-rework --run <id> [--repo owner/name]
  lh workflow run activate-step --run <id> --step execute --session <id> [--repo owner/name]
  lh workflow run await-human --run <id> --reason <text> [--repo owner/name]
  lh workflow run increase-cost-limit --run <id> --expected-limit <usd> [--repo owner/name]
  lh workflow run resume --run <id> --step execute|verify [--repo owner/name]
  lh workflow turn done [--repo owner/name] [--run <id>]   # (Execute child) declare the turn done — payload-less; the parent observes HEAD/review state
  lh workflow escalate --reason <text> [--repo owner/name] [--run <id>]   # (Execute child) request human guidance; the parent applies await-human
  lh workflow watch --repo owner/name --run <id> --since <event-id> --herdr-session <name> --parent-pane <id>   # wait for one run event, wake its parent pane once, then exit
  lh workflow step input <run> <step> [--repo owner/name] [--note <text|->] [--review <id>]   # dry-run the composed contract + input pointers + prompt for a step (no launch)
  lh workflow step status <run> [--repo owner/name] [--json]   # observe run state: HEAD vs base, last turn-done, latest workflow review freshness
  lh handoff record --phase <p> --dir <down|up> (--pr <m> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>]   # record an orchestrator<->subagent handoff (PR + session)
  lh handoff list [--pr <m>] [--issue <n>] [--session <id>] [--json]   # list handoffs for a ref, chronological
  lh retro create --pr <m> --input <file|-> [--status draft]   # save a generated retrospective (rubric+findings) for a PR
  lh retro list [--pr <m>] [--status draft]   lh retro view <id>   lh retro pending [--limit N]   # read retros / list merged PRs without one
  lh worktree prune [--repo owner/name] [--dry-run] [--yes] [--force]   # GC done PR worktrees (--force also removes dirty trees)
  lh herdr [--repo owner/name] [--json]                      # show the repo's herdr session as workspace -> tab -> agent(PR)
  lh herdr focus <pr> [--repo owner/name]                     # focus the pane of the running agent for that PR's worktree
  lh attachment add --file <path> [--file <path> ...] [--actor name]   # upload image/HTML attachment(s), print markdown
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--type type[,type]] [--run <id>] [--order asc|desc]   # print a bounded event snapshot; --type accepts exact types or namespace prefixes

  common: --session-id <uuid>  --json
  examples:
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue create --title "do the thing" [--workspace integration]
    lh workflow start 1 --workflow default --herdr
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
    lh attachment add --file report.html     # prints [report.html](/attachments/<sha256>)
    lh events --since 0
    lh events --since 120 --order asc --repo me/proj --json`);
  process.exit(group ? 1 : 0);
}
