---
name: trace-server
description: Analyze Chrome DevTools traces and raw JSON datasets through the trace-server dataset kernel. Use this whenever you need to inspect a loaded dataset, discover its schema, run reports, export artifacts, or write custom runtime queries with ds / pretty(...) / table(...).
metadata:
  author: f1shy-dev
  version: "0.4.0"
---

# trace-server

A **load-once, query-many dataset kernel**. Load a trace or JSON file, then analyze it through a rich query runtime.

> **The query runtime (`trace-server query`) is the primary interface.**
> CLI sugar commands like `table` and `report` exist for simple one-liners, but for any real analysis, use `query` with the `ds` API. See `reference.md` for the complete typed API.

## Quick start

```bash
# 1. Load
trace-server load ~/Downloads/Trace.json.gz --alias app

# 2. Discover what exists
trace-server query app "return pretty(await ds.schema.tables())"

# 3. Discover columns before querying a table
trace-server query app "return pretty(await ds.schema.describeTable('devtools.views.cpuHotspots'))"

# 4. Query
trace-server query app "
return await ds.tables
  .get('devtools.views.cpuHotspots')
  .select(['functionName', 'selfTimeMs', 'totalTimeMs'])
  .orderBy('selfTimeMs', 'desc')
  .limit(15)
  .table()
"

# 5. Unload when done
trace-server unload app
```

---

## Core concept

There are two ways to interact with data:

### Query runtime (preferred for everything)

```bash
trace-server query <session> "<js/ts code>"
```

Your code runs in a sandbox with `ds` (the dataset API root), `pretty()`, and `table()` as globals. This is the right choice when you need to:
- Chain multiple operations (filter + sort + select + limit)
- Join data from multiple tables
- Post-process or reshape results
- Build custom summaries
- Do anything beyond a trivial lookup

### CLI sugar (simple one-liners only)

```bash
trace-server table <session> <table> --limit 10 --pretty
trace-server report <session> <report> --pretty
```

These are convenience shortcuts. **Do not** use `table --sort --desc --select` chains when the query builder does it better — the builder is more expressive and composes cleanly.

**Rule of thumb:** If you're adding more than one flag to a CLI command, switch to `query`.

---

## Golden workflow

### Step 1: Load a dataset

```bash
trace-server load ~/Downloads/Trace-20260324T200940.json.gz --alias app
trace-server load ./data.json --alias raw-doc
```

### Step 2: Discover the schema first — never guess

**Always inspect before querying.** Don't guess table names or column names.

```js
// What tables exist?
return pretty(await ds.schema.tables())

// What columns does a table have? (names, types, units, descriptions)
return pretty(await ds.schema.describeTable('devtools.views.cpuHotspots'))

// What reports exist?
return pretty(await ds.schema.reports())

// What collections exist?
return pretty(await ds.schema.collections())

// For raw JSON: what paths exist?
return table((await ds.schema.paths()).slice(0, 30))
```

### Step 3: Use reports for high-level summaries

Reports are pre-built semantic summaries — use them before diving into tables.

```js
// Readable summary
return await ds.reports.get('devtools.summary').pretty()

// Interaction detail
return await ds.reports.get('devtools.interaction').args({ id: '4758' }).pretty()

// Raw result object (for post-processing)
const result = await ds.reports.run('devtools.summary')
return pretty(result)
```

### Step 4: Use the table query builder for row data

The `TableQueryHandle` is a chainable builder. Every builder method returns a new handle.

```js
// Basic: get rows with readable output
return await ds.tables.get('devtools.views.networkWaterfall').limit(20).table()

// Full chain: select → filter → sort → limit → render
return await ds.tables
  .get('devtools.views.cpuHotspots')
  .select(['functionName', 'selfTimeMs', 'totalTimeMs', 'sampleCount'])
  .where('selfTimeMs', '>', 1)
  .orderBy('selfTimeMs', 'desc')
  .limit(15)
  .table()

// Get rows as objects for post-processing
const rows = await ds.tables
  .get('devtools.views.mainThreadTasks')
  .where('durationMs', '>', 50)
  .orderBy('durationMs', 'desc')
  .rows()
return pretty({ longTasks: rows.length, top5: rows.slice(0, 5) })

// Count
const count = await ds.tables.get('devtools.facts.events').count()
return `Total events: ${count}`

// First row
const first = await ds.tables.get('devtools.dims.interactions').first()
return pretty(first)
```

### Step 5: Build token-efficient custom summaries

Manual string building is often the best output strategy for agent workflows.

```js
const interactions = await ds.tables.get('devtools.dims.interactions').rows()
const hotspots = await ds.tables
  .get('devtools.views.cpuHotspots')
  .orderBy('selfTimeMs', 'desc')
  .limit(5)
  .rows()

return [
  `Interactions: ${interactions.length}`,
  `Top CPU hotspots:`,
  ...hotspots.map(h => `  ${h.functionName}: ${h.selfTimeMs.toFixed(1)}ms self, ${h.totalTimeMs.toFixed(1)}ms total`),
].join('\n')
```

### Step 6: Export files only when needed

```js
// List available artifacts
return pretty(await ds.artifacts.list())

// Read artifact content directly (no disk write)
const src = await ds.artifacts.text('artifact:devtools:script:10')

// Materialize to disk
const file = await ds.files.materializeArtifact('artifact:devtools:script:10')
// file.path is the absolute path on disk

// Export a whole collection to a directory
const dir = await ds.files.exportCollection('devtools.screenshots')
// dir.path is the directory, dir.fileCount is the count
```

### Step 7: Clean up

```bash
trace-server unload app
```

---

## Table query builder — quick reference

`ds.tables.get(name)` returns a `TableQueryHandle`. All builder methods are chainable and return new handles.

| Method | Description |
|--------|-------------|
| `.select(["col1", "col2"])` | Project to specific columns |
| `.where("col", ">", 50)` | Filter rows (11 operators — see reference.md) |
| `.orderBy("col", "desc")` | Sort rows |
| `.limit(10)` | Limit row count |
| `.offset(20)` | Skip rows |
| `.rows()` | → `Promise<unknown[]>` — row objects |
| `.first()` | → `Promise<unknown \| null>` — first row |
| `.count()` | → `Promise<number>` — total matching rows |
| `.pretty()` | → `Promise<string>` — adaptive readable output |
| `.table()` | → `Promise<string>` — tabular output |

Filter operators: `=`, `!=`, `>`, `>=`, `<`, `<=`, `in`, `contains`, `startsWith`, `endsWith`, `between`

For the full typed API with all method signatures, types, and interfaces, see **`reference.md`**.

---

## Report query builder — quick reference

`ds.reports.get(name)` returns a `ReportQueryHandle`.

| Method | Description |
|--------|-------------|
| `.args({ key: value })` | Bind arguments (chainable) |
| `.run(args?)` | → `Promise<unknown>` — raw result |
| `.pretty(args?)` | → `Promise<string>` — readable output |

---

## Output strategy

| Goal | Method |
|------|--------|
| Quick readable look at data | `.table()` or `.pretty()` on a handle |
| Token-efficient summary | Manual string building |
| Structured data for further processing | `.rows()` then compose |
| Pretty-print any value | `pretty(value)` or `table(value)` globals |
| Raw JSON (only when needed for machine consumption) | `return result` directly |

**Avoid giant JSON dumps.** Prefer `.table()`, `.pretty()`, `pretty(...)`, `table(...)`, or manual string building.

---

## Supported dataset kinds

### DevTools traces (`.json`, `.json.gz`)

See `adapters/devtools.md` for the full table/report/collection catalog.

Key surfaces: interactions, requests, screenshots, CPU samples/hotspots, render measures, code hotspots, call trees, layout shifts, frame pipeline, network waterfall, source maps.

### Raw JSON (`.json`, `.json.gz`)

See `adapters/raw-json.md` for the full catalog.

Key surfaces: schema path discovery, inferred tables, embedded blob extraction, raw document access.

---

## Common mistakes to avoid

1. **Guessing column names** — always call `ds.schema.describeTable(name)` first
2. **Guessing table/report names** — always call `ds.schema.tables()` or `ds.schema.reports()` first
3. **Using CLI `table` with many flags** — switch to `query` with the builder chain
4. **Returning raw JSON when readability matters** — use `.table()`, `.pretty()`, or build strings
5. **Assuming dataset-specific globals** — everything starts from `ds`, no `events`/`trace`/`byName` globals
6. **Forgetting that `.get()` is synchronous** — `ds.tables.get()` and `ds.reports.get()` return handles immediately, `await` the terminal method (`.rows()`, `.pretty()`, etc.)

---

## Troubleshooting

```bash
# Session not found?
trace-server sessions

# Need layer cache state?
trace-server query <session> "return pretty(await ds.layers.status())"

# Need lease/export state?
trace-server query <session> "return pretty(await ds.files.leases())"
```

---

## Environment

Requires Node 20+ with npm.

```bash
# Global install
npm install -g @vishyfishy2/trace-server

# From source
npm install && npm run build
node dist/cli/index.js --help
```

---

## Full API reference

See **`reference.md`** for the complete typed reference of all methods, interfaces, filter operators, and return types.
