# trace-server

A Node-first dataset kernel for rich analysis artifacts.

Load a dataset once, keep it in memory, and query it many times through one stable runtime root: `ds`.

Current first-class domains:
- Chrome DevTools traces
- raw JSON / JSON.gz documents

The architecture is intentionally generic so the same kernel can later support OTEL, Sentry, bundle-analysis outputs, and multi-artifact workflows.

## Core ideas

- **stable query root**: all dataset access goes through `ds`
- **lazy layers**: expensive derived views build only when needed
- **generic tables/reports/artifacts/files**: not adapter-specific endpoint sprawl
- **runtime-first UX**: agents should primarily use JS queries against `ds`
- **readable output**: use `pretty(...)`, `table(...)`, or manual string building instead of token-heavy JSON when helpful

## Installation

```bash
npm install -g @vishyfishy2/trace-server
```

From source:

```bash
git clone https://github.com/f1shy-dev/trace-server.git
cd trace-server
npm install
npm run build
node dist/cli/index.js --help
```

## CLI overview

The CLI is intentionally generic. The most important commands are:

- `trace-server load <file> [--alias <name>]`
- `trace-server sessions`
- `trace-server info <session>`
- `trace-server caps <session>`
- `trace-server schema <session>`
- `trace-server tables <session>`
- `trace-server table <session> <table> [--limit N] [--select a,b] [--where col:op:value] [--sort col] [--desc] [--pretty|--table-format]`
- `trace-server reports <session>`
- `trace-server report <session> <report> [--args '{...}'] [--pretty]`
- `trace-server query <session> <code>`
- `trace-server artifacts <session>`
- `trace-server artifact <session> <artifact-id>`
- `trace-server collections <session>`
- `trace-server materialize <session> <artifact-id>`
- `trace-server export <session> <collection>`
- `trace-server layers <session>`
- `trace-server leases <session>`
- `trace-server unload <session>`
- `trace-server status`
- `trace-server stop`

## Quick start

### 1. Load a DevTools trace

```bash
trace-server load ~/Downloads/Trace-20260324T200940.json.gz --alias app-trace
trace-server sessions
```

### 2. Inspect schema

```bash
trace-server schema app-trace
trace-server tables app-trace
```

### 3. Run generic reports and table queries

```bash
trace-server report app-trace devtools.summary --pretty
trace-server report app-trace devtools.interaction --args '{"id":"4758"}' --pretty

trace-server table app-trace devtools.views.codeHotspots --select functionName,totalDurationMs --sort totalDurationMs --desc --limit 10 --table-format
```

### 4. Use the query runtime

Structured query:

```bash
trace-server query app-trace "
const summary = await ds.reports.run('devtools.summary');
const interactions = await ds.tables.get('devtools.dims.interactions').rows();
return { totalEvents: summary.totalEvents, interactions: interactions.length };
"
```

Readable report output:

```bash
trace-server query app-trace "
return await ds.reports.get('devtools.interaction').args({ id: '4758' }).pretty();
"
```

Explicit table output:

```bash
trace-server query app-trace "
return await ds.tables
  .get('devtools.views.codeHotspots')
  .select(['functionName', 'totalDurationMs'])
  .orderBy('totalDurationMs', 'desc')
  .limit(10)
  .table();
"
```

Manual string building is also first-class:

```bash
trace-server query app-trace "
const r = await ds.reports.run('devtools.interaction', { id: '4758' });
return [
  `interaction ${r.interaction.interactionId} ${r.interaction.durationMs.toFixed(1)}ms`,
  `droppedFrames ${r.droppedFrames}`,
  `requests ${r.requests.length}`,
].join('\\n');
"
```

## Query runtime

The query VM exposes:

- `ds`
- `pretty(value)`
- `table(value)`
- safe host utilities like `console`, timers, `URL`, `TextEncoder`, `TextDecoder`, `Buffer`

### `ds` surface

Representative APIs:

```ts
await ds.schema.tables()
await ds.schema.reports()
await ds.schema.paths()
await ds.schema.samples('$.rows[].name')

await ds.tables.get('devtools.dims.interactions').rows()
await ds.tables.get('devtools.views.codeHotspots').limit(10).table()

await ds.reports.run('devtools.summary')
await ds.reports.get('devtools.interaction').args({ id: '4758' }).pretty()

await ds.artifacts.list()
await ds.files.exportCollection('devtools.screenshots')
await ds.files.materializeArtifact('artifact:devtools:script:10')

await ds.layers.status()
```

### Table query builder

`ds.tables.get(name)` returns a chainable handle.

Supported builder operations:
- `.select(columns)`
- `.where(column, op, value)`
- `.orderBy(column, direction)`
- `.limit(n)`
- `.offset(n)`
- `.rows()`
- `.count()`
- `.pretty()`
- `.table()`

Example:

```ts
await ds.tables
  .get('raw.inferred.rows')
  .where('id', '>=', 2)
  .select(['name'])
  .rows()
```

## DevTools datasets

The DevTools driver exposes raw/fact/dimension/view/report layers for:

- processes
- threads
- frames
- workers
- requests
- request bodies when embedded in the trace
- screenshots
- interactions
- tasks
- scripts
- source maps
- original sources
- layout shifts
- soft navigations
- CPU profile nodes and samples
- frame pipeline
- render measures
- code hotspots
- CPU hotspots
- network waterfall
- visual changes

Representative reports:
- `devtools.summary`
- `devtools.interaction`
- `devtools.frame`
- `devtools.request`
- `devtools.soft-navigation`
- `devtools.hotspots`
- `devtools.script`

Representative export collections:
- `devtools.screenshots`
- `devtools.scripts`
- `devtools.network-bodies`
- `code.source-maps`
- `code.sources`

### Useful DevTools queries

List the hottest CPU nodes:

```bash
trace-server query app-trace "
return await ds.tables
  .get('devtools.views.cpuHotspots')
  .select(['functionName', 'selfTimeMs', 'totalTimeMs', 'sampleCount'])
  .limit(15)
  .table();
"
```

Inspect decoded CPU samples:

```bash
trace-server query app-trace "
return await ds.tables.get('devtools.facts.cpuSamples').limit(20).table();
"
```

See render pressure by component:

```bash
trace-server query app-trace "
return await ds.tables
  .get('devtools.views.renderComponentHotspots')
  .limit(15)
  .table();
"
```

See network waterfall rows:

```bash
trace-server query app-trace "
return await ds.tables.get('devtools.views.networkWaterfall').limit(20).table();
"
```

## Raw JSON datasets

Raw mode is not a fallback. It supports:

- schema/path discovery
- sample values
- inferred tables, including nested arrays
- time-like field detection
- embedded blob extraction heuristics
- generic exports

### Raw JSON workflow

Load a raw document:

```bash
trace-server load ./data.json --alias raw-doc
```

Inspect schema paths:

```bash
trace-server query raw-doc "
const paths = await ds.schema.paths();
return table(paths.slice(0, 20));
"
```

Inspect inferred nested tables:

```bash
trace-server query raw-doc "
return await ds.tables.get('raw.inferred.rows').table();
"
```

Show a readable raw summary:

```bash
trace-server query raw-doc "
return await ds.reports.get('raw.summary').pretty();
"
```

List embedded blobs:

```bash
trace-server query raw-doc "
return await ds.tables.get('raw.embeddedBlobs').table();
"
```

Export embedded blobs:

```bash
trace-server export raw-doc raw.embedded-blobs
```

## Artifacts, files, and workspace

Artifacts are logical dataset payloads:
- screenshots
- script source text
- source maps
- original sources
- raw embedded blobs
- request bodies when present

Files are materialized workspace outputs produced from those artifacts.

Useful queries:

```bash
trace-server query app-trace "
return await ds.artifacts.list();
"
```

```bash
trace-server query app-trace "
return await ds.files.materializeArtifact('artifact:devtools:script:10');
"
```

```bash
trace-server query app-trace "
return await ds.files.exportCollection('code.sources');
"
```

## Schema discoverability

One of the most important workflows for agents is discovering what exists before assuming a dataset shape.

Useful queries:

```bash
trace-server query app-trace "return await ds.schema.tables();"
trace-server query app-trace "return await ds.schema.reports();"
trace-server query raw-doc "return await ds.schema.paths();"
trace-server query raw-doc "return await ds.schema.samples('$.rows[].name');"
```

## Notes

- runtime is **Node-first**
- server uses **raw Node HTTP** over a Unix socket
- query transpilation uses **esbuild** first with a TypeScript fallback
- bundled distribution lives in `dist/`
- current milestone is finishing DevTools + raw mode before OTEL
