# trace-server

Load-once, query-many server for Chrome DevTools performance traces. Built for AI agents and automation workflows that need to inspect large traces repeatedly without paying JSON parse cost on every query.

## The Problem

Chrome DevTools traces are often 100-300MB+ of JSON. Traditional one-off scripts re-read and re-parse the file every time you ask a new question.

- **Without `trace-server`**: `700ms parse × 10 queries = 7,000ms` wasted on repeated setup
- **With `trace-server`**: `700ms parse once + 5ms × 10 queries = 750ms` total

`trace-server` turns trace analysis into a persistent workflow:

1. Load a trace once
2. Keep it indexed in memory
3. Query it many times from separate CLI or agent calls
4. Unload it when done

This is especially useful for AI agents that need to iteratively explore a trace: summarize it, ask follow-up questions, inspect specific events, then run custom TypeScript analysis.

## Why use it

- **Fast repeated analysis**: parses once, then serves indexed lookups from memory
- **Agent-friendly**: daemon stays alive across separate tool invocations
- **Built-in heuristics**: summary, categories, threads, network, long tasks, screenshots
- **Custom TypeScript queries**: run ad hoc code against the loaded trace
- **No manual daemon management**: CLI auto-starts the server on first use
- **Works with large traces**: supports `.json` and `.json.gz`

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

```bash
# Load a trace file. The server auto-starts in the background if needed.
trace-server load ./Performance-20260313T123456.json

# Example output:
# ✓ Loaded session: a1b2c3d4
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
trace-server stop
```

## Supported trace formats

`trace-server` accepts Chrome DevTools traces in either of these forms:

- top-level object with `traceEvents` and optional `metadata`
- legacy top-level array of trace events
- gzip-compressed files ending in `.json.gz`

## Common workflow for agents

A typical agent loop looks like this:

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

The key idea is that the server persists between commands, so an agent can make many small follow-up queries without reloading the file.

## Commands

### `load <file> [--alias <name>]`

Load a trace file into memory. Returns a generated session ID.

```bash
trace-server load ./trace.json
trace-server load ./trace.json.gz --alias homepage-load
```

Notes:

- accepts `.json` and `.json.gz`
- stores the absolute file path in the session
- builds indexes by category, name, thread, and phase
- auto-starts the daemon if it is not already running

### `sessions`

List all currently loaded sessions.

Shows:

- session ID
- alias or file path
- event count
- memory usage estimate

```bash
trace-server sessions
```

### `info <session-id>`

Show detailed information for one session.

Includes:

- file path
- alias
- event count
- duration
- file size
- memory usage
- load timestamp
- category count
- thread count
- screenshot count
- network request count
- source map count

```bash
trace-server info a1b2c3d4
```

### `summary <session-id>`

High-level overview of the trace.

Useful as the first command after loading because it quickly answers:

- how large the trace is
- how long the capture ran
- how many processes, threads, and categories exist
- whether screenshots, network events, or source maps are present
- which categories and event names dominate the trace

```bash
trace-server summary a1b2c3d4
```

### `categories <session-id>`

Show event distribution by category.

This is useful for identifying whether a trace is dominated by categories like `loading`, `devtools.timeline`, `layout`, or screenshot capture.

```bash
trace-server categories a1b2c3d4
```

### `threads <session-id>`

List threads grouped by process.

Useful when you want to know which threads are active, such as `CrBrowserMain`, `RendererMain`, or compositor-related threads.

```bash
trace-server threads a1b2c3d4
```

### `network <session-id>`

Reconstruct network requests from trace events such as:

- `ResourceSendRequest`
- `ResourceReceiveResponse`
- `ResourceFinish`

Output includes:

- HTTP method
- status code
- duration
- transfer size
- URL

```bash
trace-server network a1b2c3d4
```

### `long-tasks <session-id> [--threshold <ms>]`

Find long-running duration events (`ph: "X"`) above a threshold.

By default the threshold is `50ms`.

This is useful for surfacing expensive work such as `EvaluateScript`, `FunctionCall`, `Layout`, or `Paint`.

```bash
trace-server long-tasks a1b2c3d4
trace-server long-tasks a1b2c3d4 --threshold 100
```

### `screenshots <session-id> [--extract] [--dir <path>]`

List screenshots embedded in the trace, or extract them to JPEG files.

```bash
# List screenshots with timestamp and size
trace-server screenshots a1b2c3d4

# Extract all screenshots to the default temp directory
trace-server screenshots a1b2c3d4 --extract

# Extract to a custom directory
trace-server screenshots a1b2c3d4 --extract --dir ./trace-shots
```

Notes:

- screenshots come from `Screenshot` trace events
- extracted files are written as `.jpg`
- default extraction directory is `/tmp/trace-screenshots-<session-id>`

### `query <session-id> <code> [--file <path>] [--timeout <ms>]`

Execute TypeScript against the loaded trace in a sandboxed context.

Available variables inside the query:

- `trace`: full parsed trace object
- `events`: `trace.traceEvents`
- `metadata`: trace metadata object
- `byCategory`: `Map<string, TraceEvent[]>`
- `byName`: `Map<string, TraceEvent[]>`
- `byThread`: `Map<string, TraceEvent[]>`
- `byPhase`: `Map<string, TraceEvent[]>`

Queries can be either:

- a single expression
- a block of statements ending with `return`

Examples:

```bash
# Count all Layout events
trace-server query a1b2c3d4 "byName.get('Layout')?.length ?? 0"

# Find the first 10 Paint durations in ms
trace-server query a1b2c3d4 "(byName.get('Paint') ?? []).slice(0, 10).map(e => (e.dur ?? 0) / 1000)"

# Count FunctionCall events on a specific thread
trace-server query a1b2c3d4 "(byName.get('FunctionCall') ?? []).filter(e => `${e.pid}:${e.tid}` === '123:456').length"

# Group long Layout events by thread
trace-server query a1b2c3d4 '
const layouts = byName.get("Layout") ?? [];
const result = new Map();
for (const event of layouts) {
  const dur = (event.dur ?? 0) / 1000;
  if (dur < 16) continue;
  const key = `${event.pid}:${event.tid}`;
  result.set(key, (result.get(key) ?? 0) + 1);
}
return Object.fromEntries(result);
'

# Run a larger analysis from a file
trace-server query a1b2c3d4 --file ./analyze-trace.ts

# Raise or lower the timeout (default: 30000ms)
trace-server query a1b2c3d4 "await new Promise(r => setTimeout(r, 100)); 'done'" --timeout 500
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

## Query cookbook

A few practical examples for common trace-analysis questions.

### Count events by name

```bash
trace-server query "$SESSION" "Object.fromEntries([...byName.entries()].map(([name, list]) => [name, list.length]))"
```

### Find the slowest `Layout` events

```bash
trace-server query "$SESSION" '
(byName.get("Layout") ?? [])
  .filter(e => typeof e.dur === "number")
  .sort((a, b) => (b.dur ?? 0) - (a.dur ?? 0))
  .slice(0, 10)
  .map(e => ({
    tsMs: e.ts / 1000,
    durMs: (e.dur ?? 0) / 1000,
    pid: e.pid,
    tid: e.tid,
  }))
'
```

### Inspect all event names in the `loading` category

```bash
trace-server query "$SESSION" "[...new Set((byCategory.get('loading') ?? []).map(e => e.name))].sort()"
```

### See phase distribution

```bash
trace-server query "$SESSION" "Object.fromEntries([...byPhase.entries()].map(([phase, list]) => [phase, list.length]))"
```

### Find main-thread scripting tasks over 50ms

```bash
trace-server query "$SESSION" '
(events)
  .filter(e => ["EvaluateScript", "FunctionCall", "RunTask"].includes(e.name))
  .filter(e => ((e.dur ?? 0) / 1000) > 50)
  .map(e => ({ name: e.name, durMs: (e.dur ?? 0) / 1000, pid: e.pid, tid: e.tid }))
'
```

## HTTP API

The daemon exposes a JSON API over a Unix socket. This is useful when an agent wants to bypass the CLI and talk directly to the server.

Default socket path:

```text
~/.trace-server/server.sock
```

### Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Server health, PID, uptime, session count, memory |
| `POST` | `/sessions` | Load a trace from disk |
| `GET` | `/sessions` | List loaded sessions |
| `GET` | `/sessions/:id` | Get session details |
| `DELETE` | `/sessions/:id` | Unload a session |
| `POST` | `/sessions/:id/query` | Execute a custom query |
| `GET` | `/sessions/:id/summary` | High-level trace summary |
| `GET` | `/sessions/:id/categories` | Category breakdown |
| `GET` | `/sessions/:id/threads` | Thread listing |
| `GET` | `/sessions/:id/network` | Reconstructed network requests |
| `GET` | `/sessions/:id/long-tasks?threshold=<ms>` | Long task analysis |
| `GET` | `/sessions/:id/screenshots` | List screenshots |
| `GET` | `/sessions/:id/screenshots/:index` | Return one screenshot as JPEG bytes |
| `POST` | `/sessions/:id/screenshots/extract` | Extract all screenshots to disk |
| `POST` | `/server/stop` | Stop the daemon |

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
  "timeout": 5000
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

1. loads a trace from disk
2. parses it once
3. builds indexes for fast repeated lookup
4. serves CLI and HTTP requests over a Unix socket

Indexes are built for:

- event category
- event name
- thread (`pid:tid`)
- phase (`ph`)

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

- Start with `summary`, then `categories` or `threads`, then custom `query` calls.
- Use aliases when comparing multiple traces in one daemon session.
- Prefer built-in heuristics for common questions; they are faster to type and easier for agents to chain.
- Use `--file` for longer TypeScript analysis so your shell quoting stays sane.
- Call `unload` when you finish with a large trace to free memory.

## License

MIT

## Contributing

Architecture is implemented in the codebase; inspect `src/server/`, `src/cli/`, and `src/loader/` for the current design.
