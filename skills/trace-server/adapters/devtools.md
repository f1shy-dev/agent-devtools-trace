# Chrome DevTools adapter

Use this adapter for Chrome DevTools performance traces stored as `.json` or `.json.gz`.

## Loading

```bash
# Load a JSON trace
trace-server load ./profile.json

# Load a gzipped trace
trace-server load ./profile.json.gz

# Load with a friendly alias
trace-server load ./profile.json --alias my-trace
```

## Built-in heuristics

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

## Query variables

Available variables in the query context:

- `events` — array of all trace events (`TraceEvent[]`)
- `trace` — the full trace object with `metadata` and `traceEvents`
- `metadata` — trace metadata object
- `byCategory` — `Map<string, TraceEvent[]>`
- `byName` — `Map<string, TraceEvent[]>`
- `byThread` — `Map<string, TraceEvent[]>`
- `byPhase` — `Map<string, TraceEvent[]>`

## Query examples

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
