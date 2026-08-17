# Issue #7 — OpenCode workflow end-to-end evidence

Structural labels and paths stay in English; narrative is Japanese.

## Environment

- OpenCode CLI: 1.18.13
- herdr: 0.8.0
- Model: `opencode/big-pickle` (free)
- Launch shape used by LoopHub (interactive TUI):

```text
opencode --auto --model opencode/big-pickle --prompt <contract+user prompt>
```

Example start command:

```sh
lh workflow start <issue> --repo jugyo/loophub --workflow Build \
  --opencode --model opencode/big-pickle --herdr
```

## Acceptance criteria mapping

### 7-1 Execute / Verify completed under OpenCode

A smoke issue was run with OpenCode as the workflow runtime. Parent, Execute, and Verify
sessions all recorded `runtime=opencode` / `model=opencode/big-pickle`.

| Item | Result |
|---|---|
| Parent | OpenCode TUI in herdr; process argv `opencode --auto --model opencode/big-pickle --prompt …`; did not exit immediately |
| Execute | Same argv shape; completed a marker-file change on the smoke PR head |
| Verify | Same argv shape; submitted a **PASS** review pinned to that head (pane output: `Review submitted (id 28, PASS) pinned to head 16ac1fe`) |

Smoke deliverable (separate issue/PR created only for the run, not part of this PR’s code change):

- Issue: OpenCode e2e marker file
- PR: added `docs/evidence/opencode-workflow-e2e.txt` with content `ok`
- Commit observed on that head: `16ac1fe` (marker only)

Local CLI checks outside herdr (same machine):

- `opencode run --auto --model opencode/big-pickle --variant medium "…"` → success, exit 0  
  (`--variant` is valid on `opencode run` only)
- `opencode --auto --model opencode/big-pickle --prompt "…"` → process still alive after several seconds
- `opencode --auto --model … --variant medium --prompt "…"` → prints help and exits 1 (pre-fix failure mode)

### 7-2 Terminal pane does not exit immediately

Confirmed in herdr for parent / execute / verify panes, and by the unit/integration tests that
assert OpenCode launch argv is `--auto` / `--model` / `--prompt` without `--variant`.

### 7-3 README lists OpenCode

`README.md` runtime table includes OpenCode (`opencode`, opencode.ai), count 5, and `--opencode`
in the one-shot flag list.

### 7-4 Unfixed issues

| Finding | Disposition |
|---|---|
| TUI reject of `--variant` caused immediate pane death when Settings effort was forwarded | **Fixed in this PR** — launch argv no longer forwards effort as `--variant` |
| Settings showed an OpenCode effort ladder that launch never applied | **Fixed in this PR** — `effortSuggestions` / `defaultEffort` cleared for OpenCode so Settings does not offer a no-op control |
| Older `lh` on PATH without OpenCode maps DB `runtime=opencode` to `claude-code` via `normalizeCodingAgent` | **Operational note only** — requires an OpenCode-capable `lh` on PATH after install/merge; not a remaining product defect on this branch; no follow-up issue |

**No remaining unfixed product issues from this verification** after the two code fixes above.

## Code changes tied to this verification

1. `core/runtime-args.ts` — do not append `--variant` for OpenCode TUI launches  
2. `core/runtimes.ts` — empty effort suggestions for OpenCode  
3. `README.md` — OpenCode in the runtime table  
4. Tests — `runtime-args`, `dev`, `workflow-start`, `runtimes`, `settings-service`
