---
name: loophub
description: Work with LoopHub — a GitHub-style issue/PR hub over local git repositories — through the `lh` CLI. Use when issues, pull requests, reviews, or workflow runs live in LoopHub rather than on GitHub.
---

# LoopHub

LoopHub is a GitHub-style issue/PR hub over local git repositories, built for AI agents to run
development loops while a human supervises with minimal attention. Everything is reached through
the `lh` CLI, which reads and writes a local SQLite database — there is nothing to authenticate
against, and `gh` remains a separate tool for GitHub itself.

## Details

- `lh --help` lists every command with its usage line.
- `lh <group> --help` and `lh <group> <command> --help` describe one command's options,
  constraints, and examples.

The help is generated from the CLI itself, so it always matches the installed version.
