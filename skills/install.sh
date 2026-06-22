#!/usr/bin/env bash
# Symlink the LoopHub agent skills in this directory into ~/.claude/skills/.
# Idempotent: re-running replaces existing symlinks (ln -sfn).
set -euo pipefail

# Directory this script lives in (the repo's skills/ dir), resolved absolutely.
SKILLS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

mkdir -p "$TARGET_DIR"

count=0
for dir in "$SKILLS_DIR"/lh-*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  ln -sfn "${dir%/}" "$TARGET_DIR/$name"
  echo "linked $name -> $TARGET_DIR/$name"
  count=$((count + 1))
done

echo "Installed $count skill(s) into $TARGET_DIR"
