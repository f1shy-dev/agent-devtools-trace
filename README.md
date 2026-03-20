# trace-server

Load-once, query-many server for performance traces and bundle analysis data. Built for AI agents and automation workflows that need to inspect large datasets repeatedly without paying parse cost on every query. Supports Chrome DevTools traces and Next.js Turbopack bundle analyzer output.

## The Problem

Performance traces and bundle analysis artifacts are often large enough that repeated one-off scripts waste time re-reading and re-parsing the same data.

- **Without `trace-server`**: `700ms parse × 10 queries = 7,000ms` wasted on repeated setup
- **With `trace-server`**: `700ms parse once + 5ms × 10 queries = 750ms` total

`trace-server` turns trace analysis into a persistent workflow:

1. Load data once
2. Keep it indexed in memory
3. Query it many times from separate CLI or agent calls
4. Unload it when done

This is especially useful for AI agents that need to iteratively explore performance data: summarize it, ask follow-up questions, inspect specific routes or events, then run custom TypeScript analysis.

## Why use it

- **Fast repeated analysis**: parses once, then serves indexed lookups from memory
- **Agent-friendly**: daemon stays alive across separate tool invocations
- **Built-in heuristics**: summary plus adapter-specific commands for common investigations
- **Custom TypeScript queries**: run ad hoc code against loaded sessions
- **Multiple trace formats**: Chrome DevTools traces (`.json`, `.json.gz`) and Next.js bundle analyzer data (`next experimental-analyze`)
- **Adapter architecture**: extensible plugin system — each trace type provides its own heuristics and query context
- **No manual daemon management**: CLI auto-starts the server on first use
- **Works with large inputs**: optimized for repeated inspection of large trace or analysis files

## Installation

```bash
# Global install
bun add -g @vishyfishy2/trace-server

# Project-local install
bun add -D @vishyfishy2/trace-server
```

From source:

```bash
git clone https://github.com/f1shy-dev/agent-devtools-trace.git
cd agent-devtools-trace
bun install
bun run src/cli/index.ts --help
```

## Quick Start

Chrome DevTools trace:

```bash
# Load a trace file. The server auto-starts in the background if needed.
trace-server load ./Performance-20260313T123456.json

# Example output:
# ✓ Loaded session: a1b2c3d4
#   Type: devtools
#   File: /absolute/path/Performance-20260313T123456.json
#   Events: 1,842,331
#   Memory: 412.6 MB

# Use the returned session ID for all later commands.
trace-server summary a1b2c3d4
trace-server info a1b2c3d4

# Ask custom questions with TypeScript
trace-server query a1b2c3d4 "byName.get('Layout')?.length ?? 0"
trace-server query a1b2c3d4 "byName.get('Paint')?.slice(0, 5).map(e => e.dur ? e.dur / 1000 : 0)"

# Built-in heuristics
trace-server long-tasks a1b2c3d4 --threshold 100
trace-server network a1b2c3d4
trace-server screenshots a1b2c3d4

# When finished
trace-server unload a1b2c3d4
```

Next.js Analyze:

```bash
# Load Next.js bundle analyzer output
trace-server load .next/diagnostics/analyze/data

# Example output:
# ✓ Loaded session: b2c3d4e5
#   Type: next-analyze
#   File: /absolute/path/.next/diagnostics/analyze/data
#   Events: 842
#   Memory: 1.5 MB

# Explore the bundle
trace-server summary b2c3d4e5
trace-server routes b2c3d4e5
trace-server sizes b2c3d4e5 --route /
trace-server modules b2c3d4e5 --route / --limit 10

# Custom queries with TypeScript
trace-server query b2c3d4e5 --route / "analyze.sourceCount()"
trace-server query b2c3d4e5 "modules.moduleCount()"

# Cleanup
trace-server unload b2c3d4e5
```

## Supported formats

Chrome DevTools traces:

- top-level object with `traceEvents` and optional `metadata`
- legacy top-level array of trace events
- gzip-compressed files ending in `.json.gz`
- Session type: `devtools`

Next.js Bundle Analyzer (Turbopack):

- directory produced by `next experimental-analyze --output`
- located at `.next/diagnostics/analyze/data/`
- contains `modules.data` (binary), per-route `analyze.data` (binary), and `routes.json`
- Session type: `next-analyze`

## Common workflow for agents

Chrome DevTools trace workflow:

```bash
# 1) Load once
SESSION=$(trace-server load ./trace.json | awk '/Loaded session:/ { print $4 }')

# 2) Get the shape of the trace
trace-server summary "$SESSION"
trace-server categories "$SESSION"
trace-server threads "$SESSION"

# 3) Drill into specific questions
trace-server query "$SESSION" "byName.get('FunctionCall')?.length ?? 0"
trace-server query "$SESSION" "byCategory.get('loading')?.map(e => e.name).slice(0, 20)"
trace-server long-tasks "$SESSION" --threshold 50
trace-server network "$SESSION"

# 4) Clean up
trace-server unload "$SESSION"
```

Next.js Analyze workflow:

```bash
# 1) Generate analyze data (in your Next.js project)
npx next experimental-analyze --output

# 2) Load into trace-server
SESSION=$(trace-server load .next/diagnostics/analyze/data | awk '/Loaded session:/ { print $4 }')

# 3) Explore the bundle
trace-server summary "$SESSION"
trace-server routes "$SESSION"
trace-server sizes "$SESSION" --route /
trace-server modules "$SESSION" --route / --limit 20

# 4) Custom analysis
trace-server query "$SESSION" --route / "analyze.getRecursiveSizes(analyze.sourceRoots()[0], () => true)"
trace-server query "$SESSION" "modules.moduleDependencies(0).map(i => modules.module(i)?.path)"

# 5) Clean up
trace-server unload "$SESSION"
```

The key idea is that the server persists between commands, so an agent can make many small follow-up queries without reloading the file or directory.

## Commands

Not every command is available for every session type. Adapter-specific commands return a clear error when used on the wrong type:

```bash
$ trace-server network <analyze-session-id>
Error: Endpoint 'network' is not available for 'next-analyze' sessions
```

### `load <file> [--alias <name>]`

Load a supported trace file or analysis directory into memory. Returns a generated session ID.

```bash
trace-server load ./trace.json
trace-server load ./trace.json.gz --alias homepage-load
trace-server load ./.next/diagnostics/analyze/data --alias homepage-analyze
```

Notes:

- accepts `.json` and `.json.gz` Chrome DevTools traces
- accepts Next.js analyze directories containing `modules.data`
- stores the absolute file path in the session
- builds adapter-specific indexes and query context
- auto-starts the daemon if it is not already running

### `sessions`

List all currently loaded sessions.

Shows:

- session ID
- session type
- alias or file path
- item count
- memory usage estimate

```bash
trace-server sessions
```

### `info <session-id>`

Show detailed information for one session.

The exact metadata depends on the session type, but always includes file path, alias, size, memory usage, and load timestamp.

```bash
trace-server info a1b2c3d4
```

### `summary <session-id>`

High-level overview of the loaded session.

For DevTools traces, this surfaces event count, duration, categories, phases, screenshots, network requests, and dominant event names.

For Next.js Analyze sessions, this surfaces module count, route count, source count, output file counts, aggregate sizes, and top sources by size.

```bash
trace-server summary a1b2c3d4
trace-server summary b2c3d4e5
```

### `categories <session-id>`

Show event distribution by category.

DevTools only.

```bash
trace-server categories a1b2c3d4
```

### `threads <session-id>`

List threads grouped by process.

DevTools only.

```bash
trace-server threads a1b2c3d4
```

### `network <session-id>`

Reconstruct network requests from trace events such as `ResourceSendRequest`, `ResourceReceiveResponse`, and `ResourceFinish`.

DevTools only.

```bash
trace-server network a1b2c3d4
```

### `long-tasks <session-id> [--threshold <ms>]`

Find long-running duration events (`ph: "X"`) above a threshold.

DevTools only.

```bash
trace-server long-tasks a1b2c3d4
trace-server long-tasks a1b2c3d4 --threshold 100
```

### `screenshots <session-id> [--extract] [--dir <path>]`

List screenshots embedded in the trace, or extract them to JPEG files.

DevTools only.

```bash
# List screenshots with timestamp and size
trace-server screenshots a1b2c3d4

# Extract all screenshots to the default temp directory
trace-server screenshots a1b2c3d4 --extract

# Extract to a custom directory
trace-server screenshots a1b2c3d4 --extract --dir ./trace-shots
```

### `routes <session-id>`

List all analyzed routes with source counts, output file counts, and sizes.

Next.js Analyze only.

```bash
trace-server routes b2c3d4e5
```

### `modules <session-id> [--route <route>] [--limit <n>]`

List top modules sorted by dependency + dependent count.

Next.js Analyze only.

```bash
trace-server modules b2c3d4e5
trace-server modules b2c3d4e5 --route /about --limit 20
```

### `sizes <session-id> [--route <route>]`

Size breakdown by output type (`js`/`css`/`json`/`asset`), environment (`client`/`server`), and top output files.

Next.js Analyze only.

```bash
trace-server sizes b2c3d4e5
trace-server sizes b2c3d4e5 --route /about
```

### `query <session-id> <code> [--file <path>] [--timeout <ms>] [--route <route>]`

Execute TypeScript against the loaded session in a sandboxed context.

`--route` / `-r` selects the route-specific `AnalyzeData` instance for Next.js Analyze sessions. It is ignored for DevTools sessions.

DevTools query variables:

- `trace`: full parsed trace object
- `events`: `trace.traceEvents`
- `metadata`: trace metadata object
- `byCategory`: `Map<string, TraceEvent[]>`
- `byName`: `Map<string, TraceEvent[]>`
- `byThread`: `Map<string, TraceEvent[]>`
- `byPhase`: `Map<string, TraceEvent[]>`

Next.js Analyze query variables:

- `modules` — `ModulesData` instance (`.module(i)`, `.moduleCount()`, `.moduleDependencies(i)`, `.moduleDependents(i)`, `.asyncModuleDependencies(i)`, `.asyncModuleDependents(i)`, `.getModuleIndicesFromPath(path)`)
- `analyze` — `AnalyzeData` instance for the selected route (`.source(i)`, `.sourceCount()`, `.chunkPart(i)`, `.outputFile(i)`, `.sourceRoots()`, `.sourceChildren(i)`, `.sourceChunkParts(i)`, `.getFullSourcePath(i)`, `.getOwnSizes(i)`, `.getRecursiveSizes(i, filter)`, `.getSourceFlags(i)`)
- `routes` — `string[]` of available routes
- `allAnalyze` — `Map<string, AnalyzeData>` of all route data

Queries can be either:

- a single expression
- a block of statements ending with `return`

DevTools examples:

```bash
# Count all Layout events
trace-server query a1b2c3d4 "byName.get('Layout')?.length ?? 0"

# Find the first 10 Paint durations in ms
trace-server query a1b2c3d4 "(byName.get('Paint') ?? []).slice(0, 10).map(e => (e.dur ?? 0) / 1000)"

# Count FunctionCall events on a specific thread
trace-server query a1b2c3d4 "(byName.get('FunctionCall') ?? []).filter(e => `${e.pid}:${e.tid}` === '123:456').length"
```

Next.js Analyze examples:

```bash
# Count total modules
trace-server query "$SESSION" "modules.moduleCount()"

# Find largest sources in the root route
trace-server query "$SESSION" --route / '
const roots = analyze.sourceRoots();
const sources = [];
for (let i = 0; i < analyze.sourceCount(); i++) {
  const sizes = analyze.getOwnSizes(i);
  if (sizes.size > 0) {
    sources.push({ path: analyze.getFullSourcePath(i), ...sizes });
  }
}
return sources.sort((a, b) => b.size - a.size).slice(0, 10);
'

# List dependencies of a specific module
trace-server query "$SESSION" '
const indices = modules.getModuleIndicesFromPath("/app/page.tsx");
return indices.flatMap(i => modules.moduleDependencies(i).map(d => modules.module(d)?.path));
'

# Compare route sizes
trace-server query "$SESSION" '
return [...allAnalyze.entries()].map(([route, data]) => {
  let totalSize = 0;
  for (let i = 0; i < data.chunkPartCount(); i++) {
    totalSize += data.chunkPart(i)?.size ?? 0;
  }
  return { route, totalSize };
}).sort((a, b) => b.totalSize - a.totalSize);
'
```

Query behavior:

- default timeout is `30000ms`
- timed-out queries fail with HTTP 408 / CLI error output
- results larger than `10MB` are truncated
- CLI pretty-prints JSON-like results

### `unload <session-id>`

Remove one session from memory without stopping the daemon.

```bash
trace-server unload a1b2c3d4
```

### `status`

Show daemon status.

Includes:

- running or stopped state
- PID
- Unix socket path
- uptime
- session count
- total memory usage

```bash
trace-server status
```

### `stop`

Gracefully stop the daemon and remove the socket/PID files.

```bash
trace-server stop
```

## HTTP API

The daemon exposes a JSON API over a Unix socket. This is useful when an agent wants to bypass the CLI and talk directly to the server.

Default socket path:

```text
~/.trace-server/server.sock
```

### Endpoints

| Method | Path | Description | Trace Types |
| --- | --- | --- | --- |
| `GET` | `/health` | Server health, PID, uptime, session count, memory | all |
| `POST` | `/sessions` | Load a trace from disk | all |
| `GET` | `/sessions` | List loaded sessions | all |
| `GET` | `/sessions/:id` | Get session details | all |
| `DELETE` | `/sessions/:id` | Unload a session | all |
| `POST` | `/sessions/:id/query` | Execute a custom query | all |
| `GET` | `/sessions/:id/summary` | High-level session summary | all |
| `GET` | `/sessions/:id/categories` | Category breakdown | `devtools` |
| `GET` | `/sessions/:id/threads` | Thread listing | `devtools` |
| `GET` | `/sessions/:id/network` | Reconstructed network requests | `devtools` |
| `GET` | `/sessions/:id/long-tasks?threshold=<ms>` | Long task analysis | `devtools` |
| `GET` | `/sessions/:id/screenshots` | List screenshots | `devtools` |
| `GET` | `/sessions/:id/screenshots/:index` | Return one screenshot as JPEG bytes | `devtools` |
| `POST` | `/sessions/:id/screenshots/extract` | Extract all screenshots to disk | `devtools` |
| `GET` | `/sessions/:id/routes` | List analyzed routes with sizes | `next-analyze` |
| `GET` | `/sessions/:id/modules?route=&limit=` | Top modules by dependency count | `next-analyze` |
| `GET` | `/sessions/:id/sizes?route=` | Size breakdown by type/env | `next-analyze` |
| `POST` | `/server/stop` | Stop the daemon | all |

`POST /sessions/:id/query` accepts an optional `route` field in the JSON body for Next.js Analyze sessions.

### Example: use the API from Bun

```ts
const socket = `${process.env.HOME}/.trace-server/server.sock`;

const loadRes = await fetch("http://localhost/sessions", {
  method: "POST",
  unix: socket,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ file: "/absolute/path/to/trace.json", alias: "homepage" }),
});
const loaded = await loadRes.json();
const sessionId = loaded.sessionId;

const summaryRes = await fetch(`http://localhost/sessions/${sessionId}/summary`, {
  unix: socket,
});
console.log(await summaryRes.json());

const queryRes = await fetch(`http://localhost/sessions/${sessionId}/query`, {
  method: "POST",
  unix: socket,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    code: "byName.get('Layout')?.length ?? 0",
    timeout: 5000,
  }),
});
console.log(await queryRes.json());
```

### Example: use the API with `curl`

```bash
# Health check
curl --unix-socket "$HOME/.trace-server/server.sock" http://localhost/health

# Load a trace
curl --unix-socket "$HOME/.trace-server/server.sock" \
  -X POST http://localhost/sessions \
  -H 'content-type: application/json' \
  -d '{"file":"/absolute/path/to/trace.json","alias":"homepage"}'

# Query a loaded session
curl --unix-socket "$HOME/.trace-server/server.sock" \
  -X POST "http://localhost/sessions/a1b2c3d4/query" \
  -H 'content-type: application/json' \
  -d '{"code":"byName.get(\"Paint\")?.length ?? 0","timeout":5000}'
```

### API payloads

`POST /sessions`

```json
{
  "file": "/absolute/path/to/trace.json",
  "alias": "homepage-load"
}
```

`POST /sessions/:id/query`

```json
{
  "code": "byCategory.get('loading')?.length ?? 0",
  "timeout": 5000,
  "route": "/"
}
```

`POST /sessions/:id/screenshots/extract`

```json
{
  "outputDir": "/tmp/trace-shots"
}
```

## Architecture

`trace-server` runs as a background daemon that:

1. loads a trace file or analysis directory from disk
2. parses it once
3. builds indexes and adapter-specific context for fast repeated lookup
4. serves CLI and HTTP requests over a Unix socket

`trace-server` uses an adapter architecture where each trace format provides its own:

- file detection and parsing
- heuristic endpoints
- query context variables

Built-in adapters:

- `devtools` — Chrome DevTools traces (`.json`, `.json.gz`)
- `next-analyze` — Next.js Turbopack bundle analyzer output (directory with `.data` files)

The daemon persists across CLI invocations, so sessions remain available until you explicitly `unload` them or `stop` the server.

## Configuration

By default, runtime files live under `~/.trace-server/`.

### Environment variables

- `TRACE_SERVER_SOCKET`: override the Unix socket path
- `TRACE_SERVER_PID_FILE`: override the PID file path

Example:

```bash
export TRACE_SERVER_SOCKET=/tmp/my-trace-server.sock
export TRACE_SERVER_PID_FILE=/tmp/my-trace-server.pid
trace-server status
```

If you only set `TRACE_SERVER_SOCKET`, the default PID file becomes `<socket>.pid`.

## Practical tips

- Start with `summary`, then adapter-specific overview commands like `categories`, `threads`, `routes`, or `sizes`, then custom `query` calls.
- Use aliases when comparing multiple sessions in one daemon process.
- Prefer built-in heuristics for common questions; they are faster to type and easier for agents to chain.
- Use `--file` for longer TypeScript analysis so your shell quoting stays sane.
- Use `--route` when you want route-specific Next.js Analyze queries.
- Call `unload` when you finish with a large session to free memory.

## License

MIT

## Contributing

Architecture is implemented in the codebase; inspect `src/server/`, `src/cli/`, `src/loader/`, and `src/adapters/` for the current design.
