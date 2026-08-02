import { group } from "./args.ts";

export function usage(): void {
  console.log(`lh — LoopHub CLI

  lh info [--json]                                 # resolved env: baseUrl (Web UI), home, dbPath
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
  lh pr list|view|diff|create|update|comment|merge|review|review-response|close|reopen  [--repo owner/repo]
  lh pr feedback list|create <pr> | pending <pr> --run <id> | view|reply|resolve|reopen <conversation> --pr <pr> | react <message> --pr <pr> --emoji <emoji> [--context <lines>] [--repo owner/repo]
  lh notification send --kind merge_ready|over_budget|human_attention --title <text> --body <text|-> [--resource repo|issue:<n>|pull:<n>] [--herdr-pane-id <id>] [--source-key <key>] [--repo owner/repo]   # send a topbar notification
  lh workspace create|list|archive [<branch>] [--repo owner/name]   # workspace = integration branch; worktree = PR checkout
  lh workflow list|view|create|update|delete <name> [--description <text>] [--execute-prompt <text>] [--verify-prompt <text>] [--step execute|verify --file <path|->]   # manage global workflow prompt bundles
  lh workflow start <owner>/<repo>/<issue> | <issue> [--repo owner/name] (--workflow <name> | --workflow-id <id>) [--claude-code | --codex | --grok] [--model <name>] [--herdr] [--no-launch]   # start a Workflow run (default runtime/model from app settings; agents launch in auto mode)
  lh workflow run advance-to-verify|request-rework --run <id> [--repo owner/name]
  lh workflow run activate-step --run <id> --step execute --session <id> [--repo owner/name]
  lh workflow run await-human --run <id> --reason <text> [--repo owner/name]
  lh workflow run increase-cost-limit --run <id> --expected-limit <usd> [--repo owner/name]
  lh workflow run resume --run <id> --step execute|verify [--repo owner/name]
  lh workflow parent-ready <run> [--repo owner/name] [--json]   # (parent) declare the agent is up and reads its pane; instructions are held until this arrives
  lh workflow turn done [--repo owner/name] [--run <id>]   # (Execute child) declare the turn done — payload-less; the parent observes HEAD/review state
  lh workflow escalate --reason <text> [--repo owner/name] [--run <id>]   # (Execute child) request human guidance; the parent notifies the human and waits for an instruction
  lh workflow deliver --run <id> --text <single-line-instruction> [--repo owner/name] [--json]   # activate and deliver to the latest Execute child pane
  lh workflow escalate-human --reason <text> [--repo owner/name] [--run <id>] [--issue <n>]   # record an idempotent Issue comment
  lh workflow instruction <run> [--repo owner/name] (--event <id> --requires-changes true|false | --note <text|->) [--json]      # submit a parent input — a GitHub-reference verdict or a direct human instruction — and return the instruction it produces, without changing run state
  lh workflow effect begin|complete --repo owner/name --run <id> --event <id> --effect <key> [--json]   # durable idempotency receipt for a non-transactional parent side effect
  lh workflow cost-hold --repo owner/name --run <id> --event <id> [--json]   # hold a cost-exceeded run, interrupt its active pane, and notify the child exactly once
  lh workflow step input <run> <step> [--repo owner/name] [--note <text|->] [--review <id>]   # dry-run the composed contract + input pointers + prompt for a step (no launch)
  lh workflow step status <run> [--repo owner/name] [--json]   # observe run state: HEAD vs base, last turn-done, latest workflow review freshness
  lh handoff record --phase <p> --dir <down|up> (--pr <m> | --issue <n>) (--body <text|-> | --src <ref> [--hash <sha>]) [--from <r>] [--to <r>] [--summary <text>] [--model <m>] [--cost <json>]   # record an orchestrator<->subagent handoff (PR + session)
  lh handoff list [--pr <m>] [--issue <n>] [--session <id>] [--json]   # list handoffs for a ref, chronological
  lh retro create --pr <m> --input <file|-> [--status draft]   # save a generated retrospective (rubric+findings) for a PR
  lh retro list [--pr <m>] [--status draft]   lh retro view <id>   lh retro pending [--limit N]   # read retros / list merged PRs without one
  lh worktree prune [--repo owner/name] [--dry-run] [--yes] [--force]   # GC done PR worktrees (--force also removes dirty trees)
  lh herdr [--repo owner/name] [--json]                      # show the repo's herdr session as workspace -> tab -> agent(PR)
  lh herdr focus <pr> [--repo owner/name]                     # focus the pane of the running agent for that PR's worktree
  lh attachment add --file <path> [--file <path> ...] [--actor name]   # upload image/HTML/document (.md,.txt) attachment(s), print markdown
  lh attachment get <sha256|url> [--output <path>] [--json]   # read an attached document: text to stdout, --output to a file, --json for metadata + stored path
  lh sync                                          # detect open-PR head updates and emit events
  lh events [--since <id>] [--repo owner/repo] [--label name[,name]] [--type type[,type]] [--run <id>] [--order asc|desc]   # print a bounded event snapshot; --type accepts exact types or namespace prefixes

  common: --session-id <uuid>  --json
  examples:
    lh repo add . --name me/proj
    SID=$(uuidgen)
    lh session register --id "$SID" --agent impl-bot --session "$RUNTIME"
    lh issue create --title "do the thing" [--workspace integration]
    lh workflow start 1 --workflow default --herdr
  lh pr create --head feature-x --base main --title "impl" --issue 5
    lh pr comment 3 --body "starting work"
    lh pr comment react 12 --pr 3 --emoji "👀"
    lh notification send --repo me/proj --kind human_attention --title "Needs review" --body "PR is ready" --resource pull:3
    lh pr merge 3 --method squash
    lh pr review 3 --event request_changes --body "please fix" --comments review.json
    lh pr review 3 --event pass --body "no issues found" --commit <head sha>
    lh pr review view 3 --review 7 --json
    lh pr review 3 --comments '[{"path":"a.txt","line":2,"body":"typo"}]'   # inline JSON or a file path
    lh pr review 3 --event pass --body "all criteria met" --ac-results '[{"criterion_id":"1-1","verdict":"pass","note":""}]'
    lh pr review-response add 3 --review 7 [--review-comment 9] --body "addressed in the latest commit"
    lh pr review-response list 3 --review 7 --json
    lh pr feedback create 3 --base-sha <sha> --head-sha <sha> --path a.txt --side RIGHT --start-line 2 --end-line 2 --body "why?"
    lh pr feedback list 3 --json
    lh pr feedback pending 3 --run 42 --json      # conversations this Workflow run has not answered, with diff context
    lh pr feedback reply 12 --pr 3 --body "fixed"
    lh pr feedback resolve 12 --pr 3                 # mark complete and exclude from pending feedback
    lh pr feedback reopen 12 --pr 3                  # return a resolved conversation to pending feedback
    lh pr feedback react 18 --pr 3 --emoji "👀"
    lh attachment add --file shot.png        # prints ![shot.png](/attachments/<sha256>)
    lh attachment add --file report.html     # prints [report.html](/attachments/<sha256>)
    lh attachment add --file findings.md     # attach a hand-off document to an issue body/comment
    lh attachment get /attachments/<sha256>  # print an attached document (as linked from an issue body)
    lh events --since 0
    lh events --since 120 --order asc --repo me/proj --json`);
  process.exit(group ? 1 : 0);
}
