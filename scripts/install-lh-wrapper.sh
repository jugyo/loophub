#!/usr/bin/env bash
# Install ~/.local/bin/lh — runs the LoopHub CLI source with Bun (no build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
WRAPPER="${BIN_DIR}/lh"

mkdir -p "$BIN_DIR"

cat > "$WRAPPER" <<EOF
#!/bin/sh
# LoopHub CLI wrapper — runs source with Bun (no build).
# Re-run: ${ROOT}/scripts/install-lh-wrapper.sh
LOOPHUB_ROOT="\${LOOPHUB_ROOT:-${ROOT}}"
exec bun "\$LOOPHUB_ROOT/cli/index.ts" "\$@"
EOF

chmod +x "$WRAPPER"

echo "Installed ${WRAPPER}"
echo "LOOPHUB_ROOT override: export LOOPHUB_ROOT=/path/to/loophub"

if ! echo ":${PATH}:" | grep -q ":${BIN_DIR}:"; then
  echo "Note: ${BIN_DIR} is not on PATH. Add to shell rc:"
  echo '  export PATH="${HOME}/.local/bin:${PATH}"'
fi
