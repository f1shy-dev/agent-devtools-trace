---
name: trace-server
description: Analyze performance traces and bundle data efficiently. Supports Chrome DevTools traces (.json/.json.gz) and Next.js Turbopack bundle analyzer output. Loads data once into memory for fast repeated queries.
metadata:
  author: f1shy-dev
  version: "0.2.0"
---

# trace-server

Persistent server for analyzing performance traces and bundle analysis data. It loads a supported input once, keeps adapter-specific indexes in memory, and serves fast queries from CLI or HTTP.

## Prerequisites

Requires [Bun](https://bun.sh) runtime (v1.0+).

## Setup

Install globally:

```bash
bun add -g @vishyfishy2/trace-server
```

Or run directly without installing:

```bash
bunx @vishyfishy2/trace-server <command>
```

Verify it works:

```bash
trace-server status
```

If the server isn't running, it auto-starts on first `load` command.

## Supported adapters

| Adapter | Type | Input | Commands |
|---------|------|-------|----------|
| Chrome DevTools | `devtools` | `.json`, `.json.gz` | `summary`, `categories`, `threads`, `network`, `long-tasks`, `screenshots`, `query` |
| Next.js Analyze | `next-analyze` | directory with `modules.data` | `summary`, `routes`, `modules`, `sizes`, `query` (with `--route`) |

See `adapters/<name>.md` for adapter-specific commands and query variables.

## Core workflow

The typical analysis flow is:

1. **Load** a supported input (server auto-starts if needed)
2. **Inspect** using built-in heuristics appropriate for that adapter
3. **Query** with custom TypeScript for deeper analysis
4. **Unload** when done

### Step 1: Load data

```bash
# Load a trace file
trace-server load ./profile.json

# Load a gzipped trace
trace-server load ./profile.json.gz

# Load an analyze directory
trace-server load ./.next/diagnostics/analyze/data

# Load with a friendly alias
trace-server load ./profile.json --alias my-session
```

The output includes a **session ID** (for example `abc123`). Use this ID in all subsequent commands. If you used `--alias`, you can use the alias instead.

### Step 2: Inspect

Start with a shared overview command:

```bash
trace-server summary <session-id>
```

Then run the adapter-specific commands described in `adapters/devtools.md` or `adapters/next-analyze.md`.

### Step 3: Query

For analysis not covered by built-ins, use `query` to run arbitrary TypeScript against the loaded session:

```bash
# Inline code
trace-server query <session-id> '1 + 1'

# From a file
trace-server query <session-id> --file analysis.ts

# With timeout (default 30000ms)
trace-server query <session-id> 'expensiveAnalysis()' --timeout 10000

# Route-specific analyze query
trace-server query <session-id> --route / 'analyze?.sourceCount()'
```

Each adapter provides its own query variables and helper objects. See the adapter docs for exact variables and method signatures.

### Step 4: Cleanup

```bash
# Unload a specific session
trace-server unload <session-id>

# List all loaded sessions
trace-server sessions

# Stop the server entirely
trace-server stop
```

## Session management

```bash
# List all active sessions
trace-server sessions

# Get detailed info about a session
trace-server info <session-id>

# Check server status
trace-server status
```

## Troubleshooting

**Server won't start:** Check if port/socket is in use. The server uses a Unix socket at `~/.trace-server/server.sock`. Remove stale socket: `rm ~/.trace-server/server.sock`

**"Session not found":** Run `trace-server sessions` to see loaded sessions. Session IDs are the first 8 chars of the file hash.

**Query timeout:** Increase with `--timeout <ms>`. Default is `30000ms`. For large datasets, complex queries may need longer.

**Large input loading slow:** Large traces or analysis directories can take a few seconds to parse initially, but all subsequent queries are fast because data stays in memory.
