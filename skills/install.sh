#!/usr/bin/env bash
# Symlink the LoopHub agent skills in this directory into ~/.claude/skills/.
# Idempotent: re-running replaces existing symlinks (ln -sfn).
set -euo pipefail

# Directory this script lives in (the repo's skills/ dir), resolved absolutely.
SKILLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

mkdir -p "$TARGET_DIR"

count=0
# Symlink every skill directory (one that contains a SKILL.md). Covers the lh-* skills and
# others like create-github-pr whose slash command is hardcoded in the UI without the lh- prefix.
for dir in "$SKILLS_DIR"/*/; do
  [ -f "$dir/SKILL.md" ] || continue
  name="$(basename "$dir")"
  ln -sfn "${dir%/}" "$TARGET_DIR/$name"
  echo "linked $name -> $TARGET_DIR/$name"
  count=$((count + 1))
done

echo "Installed $count skill(s) into $TARGET_DIR"
