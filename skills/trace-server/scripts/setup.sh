#!/bin/bash
set -euo pipefail

echo "Setting up trace-server..." >&2

if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required but not installed." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but not installed." >&2
  exit 1
fi

echo "Node found: $(node --version)" >&2
echo "npm found: $(npm --version)" >&2

echo "Installing @vishyfishy2/trace-server..." >&2
npm install -g @vishyfishy2/trace-server

if command -v trace-server >/dev/null 2>&1; then
  echo "trace-server installed successfully" >&2
  trace-server status >&2 || true
  echo '{"success": true, "version": "0.3.0"}'
else
  echo "Error: trace-server not found after installation" >&2
  echo '{"success": false, "error": "trace-server not found in PATH"}'
  exit 1
fi
