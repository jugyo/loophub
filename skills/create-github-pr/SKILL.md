---
name: create-github-pr
description: >-
  Deprecated compatibility alias for lh-create-github-pr. Use when the user runs
  /create-github-pr {pr id}; read skills/lh-create-github-pr/SKILL.md and follow that workflow.
---

# Deprecated GitHub PR export alias

`/create-github-pr <pr id>` is kept only for existing users and installed agents. New docs, UI
launches, and workflow-skill customization should use `/lh-create-github-pr <pr id>`.

This alias is shipped with `skills/lh-create-github-pr/`; the canonical skill must be installed next to
it. If `skills/lh-create-github-pr/SKILL.md` is unavailable in an installed environment, reinstall the
canonical skill before continuing instead of guessing the export procedure. From a remote skill source,
use:

```sh
npx skills add <owner>/<repo> --skill lh-create-github-pr
```

From this repository's local checkout, use:

```sh
npx skills add . --skill lh-create-github-pr
```

When invoked through this alias, read `skills/lh-create-github-pr/SKILL.md` and follow the
`lh-create-github-pr` procedure exactly. Do not run a different flow.
