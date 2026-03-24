# trace-server API Reference

Complete typed reference for the query runtime. Use this when writing `trace-server query <session> "..."` code.

---

## Sandbox globals

Every query runs in a Node.js VM sandbox with these globals:

| Global | Type | Notes |
|--------|------|-------|
| `ds` | `DatasetQueryApi` | The dataset root — all data access starts here |
| `pretty(value, options?)` | `(value: unknown, options?: PrettyOptions) => string` | Adaptive readable output (auto-detects tables vs objects) |
| `table(value, options?)` | `(value: unknown, options?: { maxRows?: number }) => string` | Force tabular output for arrays of objects |
| `console` | `Console` | Standard console |
| `performance` | `Performance` | For timing |
| `Buffer` | `typeof Buffer` | Node Buffer |
| `URL` | `typeof URL` | URL parsing |
| `TextEncoder` | `typeof TextEncoder` | Encoding |
| `TextDecoder` | `typeof TextDecoder` | Decoding |
| `setTimeout` | `typeof setTimeout` | Timers |
| `clearTimeout` | `typeof clearTimeout` | |
| `setInterval` | `typeof setInterval` | |
| `clearInterval` | `typeof clearInterval` | |

### PrettyOptions

```ts
interface PrettyOptions {
  maxRows?: number;
  mode?: "auto" | "table";
}
```

---

## `ds` — DatasetQueryApi

The root object for all data access. Every method is async unless noted.

### `ds.caps`

```ts
ds.caps.all(): Promise<CapabilityMap>
```

Returns detected dataset capabilities as a flat key-value map.

```ts
type CapabilityMap = Record<string, string | number | boolean | null>;
```

---

### `ds.schema`

Schema discovery. **Always start here when working with an unfamiliar dataset.**

```ts
ds.schema.kind(): Promise<string>
// Returns "devtools-trace" | "raw-json" | etc.

ds.schema.namespaces(): Promise<string[]>
// Returns deduplicated namespace prefixes, e.g. ["devtools", "code", "raw"]

ds.schema.tables(): Promise<TableInfo[]>
// All registered tables with columns and descriptions

ds.schema.reports(): Promise<ReportInfo[]>
// All registered reports

ds.schema.collections(): Promise<FileCollectionInfo[]>
// All file export collections

ds.schema.describeTable(name: string): Promise<TableInfo | null>
// Full column metadata for one table — use this before querying to know column names and types

ds.schema.describeReport(name: string): Promise<ReportInfo | null>
// Metadata for one report

ds.schema.paths(): Promise<SchemaPath[]>
// JSON paths discovered in the raw document (useful for raw-json datasets)

ds.schema.samples(path: string): Promise<unknown[]>
// Sample values at a JSON path, e.g. ds.schema.samples('$.rows[].name')
```

#### TableInfo

```ts
interface TableInfo {
  name: string;
  description: string;
  columns: TableColumn[];
}
```

#### TableColumn

```ts
interface TableColumn {
  name: string;
  type: string;          // "string" | "number" | "boolean" | "object" | "array" | etc.
  description?: string;
  unit?: string;         // "ms" | "bytes" | etc.
}
```

#### ReportInfo

```ts
interface ReportInfo {
  name: string;
  description: string;
}
```

#### FileCollectionInfo

```ts
interface FileCollectionInfo {
  id: string;
  description: string;
}
```

#### SchemaPath

```ts
interface SchemaPath {
  path: string;
  count: number;
  types: string[];
  samples: Array<string | number | boolean | null>;
}
```

---

### `ds.raw`

Direct access to the underlying document. Mainly useful for raw-json datasets.

```ts
ds.raw.document(): Promise<unknown>
// The entire parsed JSON document

ds.raw.rows(name: string): Promise<unknown[]>
// Named raw row providers registered by adapters
```

---

### `ds.tables`

Table access. This is the primary data query surface.

```ts
ds.tables.names(): Promise<string[]>
// List of all table names

ds.tables.get(name: string): TableQueryHandle
// Returns a chainable query builder — throws if table not found
// NOTE: this is synchronous, it returns a handle immediately
```

---

### `ds.reports`

Report access. Reports are pre-built semantic summaries.

```ts
ds.reports.names(): Promise<string[]>
// List of all report names

ds.reports.run(name: string, args?: Record<string, unknown>): Promise<unknown>
// Run a report and get its raw result object

ds.reports.get(name: string): ReportQueryHandle
// Returns a chainable report builder — throws if report not found
// NOTE: this is synchronous, it returns a handle immediately
```

---

### `ds.artifacts`

Artifact access. Artifacts are materialized files (scripts, images, blobs).

```ts
ds.artifacts.list(): Promise<ArtifactRef[]>
// All available artifacts

ds.artifacts.get(id: string): Promise<ArtifactRef | null>
// Metadata for one artifact

ds.artifacts.text(id: string): Promise<string>
// Read artifact as text (works for text, json, or binary-as-utf8)

ds.artifacts.json<T = unknown>(id: string): Promise<T>
// Read artifact as parsed JSON

ds.artifacts.bytes(id: string): Promise<Uint8Array>
// Read artifact as raw bytes
```

#### ArtifactRef

```ts
interface ArtifactRef {
  id: string;
  kind: "text" | "json" | "image" | "binary";
  mediaType: string;
  sizeBytes?: number;
  filenameHint?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}
```

---

### `ds.files`

File materialization. Writes artifacts/collections to the workspace directory on disk.

```ts
ds.files.listCollections(): Promise<FileCollectionInfo[]>
// All export collections

ds.files.materializeArtifact(artifactId: string, options?: Record<string, unknown>): Promise<MaterializedFile>
// Write one artifact to disk, returns the file path

ds.files.exportCollection(collectionId: string, options?: Record<string, unknown>): Promise<MaterializedDirectory>
// Export an entire collection to a directory

ds.files.releaseLease(leaseId: string): Promise<{ ok: boolean; leaseId: string }>
// Release a workspace lease (cleans up exported files)

ds.files.pinLease(leaseId: string): Promise<LeaseInfo | null>
// Pin a lease to prevent auto-cleanup

ds.files.unpinLease(leaseId: string): Promise<LeaseInfo | null>
// Unpin a lease

ds.files.leases(): Promise<LeaseInfo[]>
// List all active leases
```

#### MaterializedFile

```ts
interface MaterializedFile {
  kind: "file";
  path: string;         // absolute file path on disk
  artifactId: string;
  bytes?: number;
  leaseId: string;
}
```

#### MaterializedDirectory

```ts
interface MaterializedDirectory {
  kind: "directory";
  path: string;          // absolute directory path on disk
  manifestPath: string;
  collectionId: string;
  fileCount: number;
  leaseId: string;
}
```

#### LeaseInfo

```ts
interface LeaseInfo {
  leaseId: string;
  kind: "scratch" | "export";
  purpose: string;
  path: string;
  createdAt: string;
  pinned: boolean;
  status: "active" | "released";
  bytes?: number;
  expiresAt?: string;
}
```

---

### `ds.workspace`

Workspace management for scratch directories.

```ts
ds.workspace.root(): Promise<string>
// The workspace root directory path

ds.workspace.allocScratchDir(purpose: string): Promise<{ path: string; leaseId: string }>
// Allocate a temporary scratch directory

ds.workspace.releaseLease(leaseId: string): Promise<{ ok: boolean; leaseId: string }>
ds.workspace.pinLease(leaseId: string): Promise<LeaseInfo | null>
ds.workspace.unpinLease(leaseId: string): Promise<LeaseInfo | null>
ds.workspace.leases(): Promise<LeaseInfo[]>
```

---

### `ds.layers`

Layer cache introspection. Layers are lazily-built intermediate data structures.

```ts
ds.layers.status(): Promise<LayerStatusInfo[]>
// All layer states (cold, building, ready, failed)

ds.layers.evict(key: string): Promise<{ ok: boolean; key: string }>
// Evict a cached layer to free memory

ds.layers.pin(key: string): Promise<LayerStatusInfo | null>
// Pin a layer to prevent eviction

ds.layers.unpin(key: string): Promise<LayerStatusInfo | null>
// Unpin a layer
```

#### LayerStatusInfo

```ts
interface LayerStatusInfo {
  key: string;
  status: string;        // "cold" | "building" | "ready" | "failed"
  buildMs?: number;
  lastAccessedAt?: string;
  sizeBytes?: number;
  deps?: string[];
  evictable: boolean;
  pinned: boolean;
}
```

---

### `ds.ns`

Namespace bag. Adapters can register arbitrary namespace objects here. Access with `ds.ns.someNamespace`.

```ts
ds.ns: Record<string, unknown>
```

---

## TableQueryHandle

Returned by `ds.tables.get(name)`. Chainable — every builder method returns a new handle (immutable).

### Builder methods (chainable)

```ts
handle.select(columns: string[]): TableQueryHandle
// Project to specific columns
// Example: .select(["functionName", "totalDurationMs"])

handle.where(column: string, op: TableFilterOp, value: unknown): TableQueryHandle
handle.where(filter: TableFilter): TableQueryHandle
// Filter rows
// Example: .where("durationMs", ">", 50)
// Example: .where("name", "contains", "render")
// Example: .where({ column: "id", op: "in", values: [1, 2, 3] })

handle.orderBy(column: string, direction?: "asc" | "desc"): TableQueryHandle
// Sort rows — defaults to "asc"
// Example: .orderBy("totalDurationMs", "desc")

handle.limit(n: number): TableQueryHandle
// Limit row count
// Example: .limit(10)

handle.offset(n: number): TableQueryHandle
// Skip rows (for pagination)
// Example: .offset(20)

handle.query(plan: TableQueryPlan): TableQueryHandle
// Apply a full query plan object at once (advanced)
```

### Terminal methods (execute the query)

```ts
handle.rows(plan?: TableQueryPlan): Promise<unknown[]>
// Execute and return row objects
// This is the most common terminal — use when you need to post-process in JS

handle.first(): Promise<unknown | null>
// Return the first row or null (equivalent to .limit(1).rows()[0])

handle.count(): Promise<number>
// Return row count matching the current filters (ignores limit/offset)

handle.pretty(options?: PrettyOptions): Promise<string>
// Execute and return adaptive readable output

handle.table(options?: PrettyOptions): Promise<string>
// Execute and return tabular output

handle.plan(): TableQueryPlan
// Inspect the current query plan (synchronous, does not execute)
```

### Chaining example

```js
// Full chain: select → filter → sort → limit → render
await ds.tables
  .get("devtools.views.cpuHotspots")
  .select(["functionName", "selfTimeMs", "totalTimeMs", "sampleCount"])
  .where("selfTimeMs", ">", 1)
  .orderBy("selfTimeMs", "desc")
  .limit(15)
  .table()
```

---

## ReportQueryHandle

Returned by `ds.reports.get(name)`. Chainable for binding args.

```ts
handle.args(args: Record<string, unknown>): ReportQueryHandle
// Bind arguments — returns a new handle
// Example: .args({ id: "4758" })

handle.run(args?: Record<string, unknown>): Promise<unknown>
// Execute and return raw result object
// Merges any provided args with previously bound args

handle.pretty(args?: Record<string, unknown>): Promise<string>
// Execute and return readable output
```

### Example

```js
// Bind args then get readable output
await ds.reports.get("devtools.interaction").args({ id: "4758" }).pretty()

// Or pass args directly
await ds.reports.get("devtools.summary").pretty()
```

---

## TableFilterOp

All supported filter operators:

| Operator | Description | Value field |
|----------|-------------|-------------|
| `"="` | Equals | `value` |
| `"!="` | Not equals | `value` |
| `">"` | Greater than | `value` |
| `">="` | Greater than or equal | `value` |
| `"<"` | Less than | `value` |
| `"<="` | Less than or equal | `value` |
| `"in"` | Value in array | `values` |
| `"contains"` | String contains | `value` |
| `"startsWith"` | String starts with | `value` |
| `"endsWith"` | String ends with | `value` |
| `"between"` | Between range | `lower`, `upper` |

### TableFilter (object form)

```ts
interface TableFilter {
  column: string;
  op: TableFilterOp;
  value?: unknown;       // for =, !=, >, >=, <, <=, contains, startsWith, endsWith
  values?: unknown[];    // for "in"
  lower?: unknown;       // for "between"
  upper?: unknown;       // for "between"
}
```

### TableSort

```ts
interface TableSort {
  column: string;
  direction?: "asc" | "desc";  // default: "asc"
}
```

### TableQueryPlan

The full query plan shape (used by `.query()` and `.rows(plan)`):

```ts
interface TableQueryPlan {
  select?: string[];
  where?: TableFilter[];
  orderBy?: TableSort[];
  offset?: number;
  limit?: number;
}
```

---

## CLI command reference (quick)

CLI commands are convenience wrappers. For anything beyond simple one-liners, use `query` instead.

### Lifecycle

```
trace-server load <file> [--alias <name>]
trace-server sessions
trace-server info <session>
trace-server unload <session>
trace-server status
trace-server stop
```

### Discovery

```
trace-server caps <session>
trace-server schema <session>
trace-server tables <session>
trace-server reports <session>
trace-server artifacts <session>
trace-server collections <session>
trace-server layers <session>
trace-server leases <session>
```

### Data (simple one-liners only)

```
trace-server table <session> <table> [--limit N] [--select col1,col2] [--sort col] [--desc] [--where col:op:val] [--pretty] [-T]
trace-server report <session> <report> [--args '{"key":"val"}'] [--pretty]
trace-server artifact <session> <artifact-id>
```

### Files

```
trace-server materialize <session> <artifact-id>
trace-server export <session> <collection-id>
```

### Runtime (primary interface)

```
trace-server query <session> "<code>" [--timeout N]
```
