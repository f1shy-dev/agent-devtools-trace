#!/bin/bash
set -e

echo "Setting up trace-server..." >&2

# Check for bun
if ! command -v bun &> /dev/null; then
  echo "Error: bun is required but not installed." >&2
  echo "Install bun: curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

echo "Bun found: $(bun --version)" >&2

# Install trace-server globally
echo "Installing @vishyfishy2/trace-server..." >&2
bun add -g @vishyfishy2/trace-server

# Verify installation
if command -v trace-server &> /dev/null; then
  echo "trace-server installed successfully" >&2
  trace-server status >&2 || true
  echo '{"success": true, "version": "0.1.0"}'
else
  echo "Error: trace-server not found after installation" >&2
  echo '{"success": false, "error": "trace-server not found in PATH"}'
  exit 1
fi
