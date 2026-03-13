---
name: trace-server
description: Analyze Chrome DevTools performance traces efficiently. Use when working with .json or .json.gz trace files, profiling web performance, debugging slow pages, or investigating network waterfalls. Loads traces once into memory for fast repeated queries.
metadata:
  author: f1shy-dev
  version: "0.1.0"
---

# trace-server

Persistent server for analyzing Chrome DevTools performance traces. Loads a trace once, keeps it indexed in memory, and serves fast queries from CLI or HTTP.

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

## Core Workflow

The typical analysis flow is:

1. **Load** a trace file (server auto-starts if needed)
2. **Inspect** using built-in heuristics (summary, network, long-tasks, etc.)
3. **Query** with custom TypeScript for deeper analysis
4. **Unload** when done

### Step 1: Load a Trace

```bash
# Load a JSON trace
trace-server load ./profile.json

# Load a gzipped trace
trace-server load ./profile.json.gz

# Load with a friendly alias
trace-server load ./profile.json --alias my-trace
```

The output includes a **session ID** (e.g., `abc123`). Use this ID in all subsequent commands. If you used `--alias`, you can use the alias instead.

### Step 2: Built-in Heuristics

Run these to get structured analysis without writing code:

```bash
# High-level overview (event count, duration, categories, phases)
trace-server summary <session-id>

# Event categories with counts and percentages
trace-server categories <session-id>

# Thread breakdown (which threads are busiest)
trace-server threads <session-id>

# Network requests (URLs, status codes, timing, sizes)
trace-server network <session-id>

# Long tasks over 50ms (or custom threshold)
trace-server long-tasks <session-id>
trace-server long-tasks <session-id> --threshold 100

# Screenshot events in the trace
trace-server screenshots <session-id>
```

### Step 3: Custom TypeScript Queries

For analysis not covered by built-ins, use `query` to run arbitrary TypeScript against the loaded trace:

```bash
# Inline code
trace-server query <session-id> 'events.filter(e => e.name === "Layout").length'

# From a file
trace-server query <session-id> --file analysis.ts

# With timeout (default 30000ms)
trace-server query <session-id> 'expensiveAnalysis(events)' --timeout 10000
```

**Available variables in query context:**
- `events` — array of all trace events (`TraceEvent[]`)
- `trace` — the full trace object with `metadata` and `traceEvents`
- `session` — session metadata (id, file path, event count)

**Query examples:**

Count events by type:
```typescript
const counts = new Map<string, number>();
for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
[...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
```

Find slowest Layout events:
```typescript
events
  .filter(e => e.name === 'Layout' && e.dur)
  .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
  .slice(0, 5)
  .map(e => ({ ts: e.ts, dur: `${(e.dur! / 1000).toFixed(1)}ms` }))
```

Analyze network requests by type:
```typescript
const sends = events.filter(e => e.name === 'ResourceSendRequest');
sends.map(e => ({
  url: e.args?.data?.url,
  type: e.args?.data?.resourceType,
  method: e.args?.data?.requestMethod
}))
```

Find main-thread scripting over 50ms:
```typescript
events
  .filter(e => e.cat?.includes('devtools.timeline') && (e.dur ?? 0) > 50000 && e.tid === 1)
  .map(e => ({ name: e.name, dur: `${(e.dur! / 1000).toFixed(1)}ms`, ts: e.ts }))
  .sort((a, b) => parseFloat(b.dur) - parseFloat(a.dur))
```

### Step 4: Cleanup

```bash
# Unload a specific session
trace-server unload <session-id>

# List all loaded sessions
trace-server sessions

# Stop the server entirely
trace-server stop
```

## Session Management

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

**Query timeout:** Increase with `--timeout <ms>`. Default is 30000ms. For large traces, complex queries may need longer.

**Large trace loading slow:** Gzipped traces (`.json.gz`) decompress on load. A 300MB trace may take 2-5 seconds to parse initially, but all subsequent queries are fast.
