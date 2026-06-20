#!/usr/bin/env bash
# Install ~/.local/bin/lh — runs the LoopHub CLI source via Node + tsx (no build).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN_DIR="${HOME}/.local/bin"
WRAPPER="${BIN_DIR}/lh"

mkdir -p "$BIN_DIR"

cat > "$WRAPPER" <<EOF
#!/bin/sh
# LoopHub CLI wrapper — runs source via Node + tsx (no build).
# Re-run: ${ROOT}/scripts/install-lh-wrapper.sh
LOOPHUB_ROOT="\${LOOPHUB_ROOT:-${ROOT}}"
# node:sqlite is experimental on Node 22.x; the flag is required at startup. tsx forwards
# NODE_OPTIONS to the node process it runs the CLI in.
export NODE_OPTIONS="--experimental-sqlite --disable-warning=ExperimentalWarning\${NODE_OPTIONS:+ \$NODE_OPTIONS}"
exec "\$LOOPHUB_ROOT/node_modules/.bin/tsx" "\$LOOPHUB_ROOT/cli/index.ts" "\$@"
EOF

chmod +x "$WRAPPER"

echo "Installed ${WRAPPER}"
echo "LOOPHUB_ROOT override: export LOOPHUB_ROOT=/path/to/loophub"

if ! echo ":${PATH}:" | grep -q ":${BIN_DIR}:"; then
  echo "Note: ${BIN_DIR} is not on PATH. Add to shell rc:"
  echo '  export PATH="${HOME}/.local/bin:${PATH}"'
fi
