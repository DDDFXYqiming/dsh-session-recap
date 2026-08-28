#!/bin/bash
# Cross-shell shim for the Windows-native DSH build.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_MNT="$(dirname "$SCRIPT_DIR")"

NODE_EXE="${NODE_EXE:-}"
if [ -z "$NODE_EXE" ]; then
  NODE_EXE="$(command -v node.exe 2>/dev/null || command -v node 2>/dev/null || true)"
fi
if [ -z "$NODE_EXE" ]; then
  echo "build: cannot locate node or node.exe" >&2
  exit 1
fi

case "$NODE_EXE" in
  *.exe|*.EXE)
    if command -v wslpath >/dev/null 2>&1; then
      SCRIPT_ARG="$(wslpath -w "$SCRIPT_DIR/build.mjs")"
      ROOT_ARG="$(wslpath -w "$ROOT_MNT")"
    else
      SCRIPT_ARG="$(cd "$SCRIPT_DIR" && pwd -W 2>/dev/null)/build.mjs"
      ROOT_ARG="$(cd "$ROOT_MNT" && pwd -W 2>/dev/null)"
    fi
    ;;
  *)
    SCRIPT_ARG="$SCRIPT_DIR/build.mjs"
    ROOT_ARG="$ROOT_MNT"
    ;;
esac

exec "$NODE_EXE" "$SCRIPT_ARG" "$ROOT_ARG"
