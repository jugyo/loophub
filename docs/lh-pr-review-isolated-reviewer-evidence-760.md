# lh-pr-review isolated reviewer evidence for issue 760

## Scope

This records the post-change verification for issue #760. The goal was to remove parent-conversation
history inheritance from `lh-pr-review` reviewers while keeping reviewer-side repository exploration
available.

## Baseline

Issue #760 cites PR #756 (`/lh-build 749`) as the baseline:

- Total run cost: 96.6M tokens / $90.01
- Reviewer subagents: 85.9M tokens, about 88% of the run
- Reviewer cost per reviewer: 15-19M tokens in the measured codex-host run

## Post-change run

This PR was implemented through `/lh-build 760`, then reviewed with the updated `lh-pr-review` flow. The
selected reviewers were:

- Quality: ran because the diff touches `skills/`
- Security: skipped because the diff is documentation-only
- Documentation: ran because the diff changes Markdown documentation
- Acceptance: ran because PR #761 is linked to issue #760

The reviewer sessions were launched as fresh non-interactive Codex sessions:

```sh
codex exec --cd /Users/jugyo/.loophub/worktrees/jugyo/loophub/pr-761 \
  --sandbox read-only --ephemeral --json --output-last-message /tmp/lh-pr-761-<role>.json -
```

Each reviewer prompt included only objective inputs: repository path, base branch, `lh pr diff 761
--repo jugyo/loophub`, and role-specific issue data for Acceptance. The parent conversation transcript,
implementation notes, test logs, and implementer summary were not passed.

## Reviewer token usage

The `codex exec --json` `turn.completed` events reported:

| Reviewer | input_tokens | cached_input_tokens | output_tokens | reasoning_output_tokens | Total input/cache/output (excludes reasoning) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quality | 131,056 | 96,640 | 7,358 | 7,078 | 235,054 |
| Documentation | 20,015 | 4,224 | 9,018 | 9,007 | 33,257 |
| Acceptance | 21,102 | 4,224 | 4,385 | 4,257 | 29,711 |

All three reviewers were below 1M tokens. The largest reviewer, Quality, used about 0.235M
input/cache/output tokens, compared with the 15-19M/reviewer baseline from issue #760.

## Main `lh-build` session usage

LoopHub recorded the parent `/lh-build 760` session usage for PR #761 as:

```text
input_tokens=188,060
cache_creation_input_tokens=0
cache_read_input_tokens=2,617,728
output_tokens=20,316
total_tokens=2,826,104
cost_usd=2.858644
```

The parent-session total is not the reviewer-per-session metric; it is included to tie this evidence to
the `/lh-build 760` run visible from PR #761.
