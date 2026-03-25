# Next.js Turbopack bundle analyzer dataset guide

Use this guide for Next.js Turbopack bundle analyzer directories loaded into the dataset kernel. For the complete typed API (method signatures, interfaces, filter operators), see **`../reference.md`**.

## Generating the trace

The Next.js Turbopack bundle analyzer is built into Next.js 16.1+. Run:

```bash
npx next experimental-analyze --output
```

This builds the project with Turbopack's analyzer and writes results to `.next/diagnostics/analyze/`. The `--output` flag writes to disk instead of starting an interactive server.

Load the `data/` subdirectory:

```bash
trace-server load .next/diagnostics/analyze/data --alias mynextapp
```

Other useful flags:
- `--no-mangling` — disable identifier mangling (for debugging)
- `--profile` — enable CPU profiling
- `--port <port>` — set the interactive server port (when not using `--output`)
- `--experimental-app-only` — analyze only the App Router

Without `--output`, the command starts an interactive server at `http://localhost:4000` with a treemap UI.


Supported inputs:
- analyzer output directory containing `analyze.data`
- optional `modules.data`
- optional `routes.json`
- optional per-route subdirectories with their own `analyze.data`

## What the Next.js bundle pack exposes

### Dimensions
- `nextbundle.dims.sources`
- `nextbundle.dims.outputFiles`
- `nextbundle.dims.chunkParts`
- `nextbundle.dims.modules`
- `nextbundle.dims.routes`

### Views
- `nextbundle.views.sourceTree`
- `nextbundle.views.moduleDependencies`
- `nextbundle.views.packageSizes`
- `nextbundle.views.routeSizes`
- `nextbundle.views.environmentBreakdown`

### Reports
- `nextbundle.summary`
- `nextbundle.route`

### Namespace helpers
- `ds.ns.nextbundle.report.summary()`
- `ds.ns.nextbundle.report.route({ route })`
- `ds.ns.nextbundle.sources()`
- `ds.ns.nextbundle.modules()`
- `ds.ns.nextbundle.outputFiles()`
- `ds.ns.nextbundle.routes()`

## Table catalog

### `nextbundle.dims.sources`
Source tree nodes reconstructed from `analyze.data`.

| Column | Type | Notes |
|--------|------|-------|
| `sourceIndex` | number | Index in `sources[]` |
| `path` | string | Full reconstructed path |
| `segment` | string | Original path segment |
| `parentIndex` | number | Parent source index |
| `isDirectory` | boolean | Directory flag |
| `totalSize` | number (bytes) | Aggregated size for this subtree |
| `compressedSize` | number (bytes) | Aggregated compressed size |
| `chunkPartCount` | number | Chunk part count in subtree |

### `nextbundle.dims.outputFiles`
Output files produced by the analyzed build.

| Column | Type | Notes |
|--------|------|-------|
| `fileIndex` | number | Index in `output_files[]` |
| `filename` | string | Raw output filename |
| `cleanFilename` | string | With `[output]/` stripped |
| `environment` | string | `server` if path contains `/server/`, else `client` |
| `fileType` | string | `js`, `css`, `json`, or `other` |
| `totalSize` | number (bytes) | Total linked size |
| `compressedSize` | number (bytes) | Total compressed size |
| `chunkPartCount` | number | Linked chunk part count |

### `nextbundle.dims.chunkParts`
Source-to-output-file size links.

| Column | Type | Notes |
|--------|------|-------|
| `chunkPartIndex` | number | Chunk part index |
| `sourceIndex` | number | Source index |
| `sourcePath` | string | Reconstructed source path |
| `outputFileIndex` | number | Output file index |
| `outputFilename` | string | Raw output filename |
| `size` | number (bytes) | Uncompressed size |
| `compressedSize` | number (bytes) | Compressed size |

### `nextbundle.dims.modules`
Module graph rows from `modules.data`.

| Column | Type | Notes |
|--------|------|-------|
| `moduleIndex` | number | Module index |
| `ident` | string | Full module identifier |
| `path` | string | Full module path |
| `cleanPath` | string | With `[project]/` stripped |
| `isNodeModule` | boolean | Node module flag |
| `packageName` | string | npm package name when applicable |
| `dependencyCount` | number | Sync dependency count |
| `asyncDependencyCount` | number | Async dependency count |
| `dependentCount` | number | Sync dependent count |
| `asyncDependentCount` | number | Async dependent count |

### `nextbundle.dims.routes`
Route manifest rows from `routes.json`.

| Column | Type | Notes |
|--------|------|-------|
| `route` | string | Route path |
| `hasAnalyzeData` | boolean | Whether a per-route analyzer file exists |

### `nextbundle.views.sourceTree`
Leaf source rows enriched with output-file presence.

Columns from `nextbundle.dims.sources`, plus:

| Column | Type | Notes |
|--------|------|-------|
| `outputFileCount` | number | Number of output files containing the source |
| `outputFiles` | string | Comma-separated output files |
| `environments` | string | Comma-separated environments |

### `nextbundle.views.moduleDependencies`
Flattened module dependency edges.

| Column | Type | Notes |
|--------|------|-------|
| `fromModule` | string | Source module path |
| `toModule` | string | Target module path |
| `kind` | string | `sync` or `async` |

### `nextbundle.views.packageSizes`
Package aggregation across source sizes and module counts.

| Column | Type | Notes |
|--------|------|-------|
| `packageName` | string | npm package name |
| `totalSize` | number (bytes) | Aggregate source size |
| `compressedSize` | number (bytes) | Aggregate compressed size |
| `moduleCount` | number | Number of matching modules |
| `sourceCount` | number | Number of matching leaf sources |

### `nextbundle.views.routeSizes`
Per-route analyzer totals derived from each route subdirectory.

| Column | Type | Notes |
|--------|------|-------|
| `route` | string | Route path |
| `totalSize` | number (bytes) | Total uncompressed size |
| `compressedSize` | number (bytes) | Total compressed size |
| `sourceCount` | number | Source tree node count |
| `outputFileCount` | number | Output file count |
| `chunkPartCount` | number | Chunk part count |

### `nextbundle.views.environmentBreakdown`
Server vs client output breakdown.

| Column | Type | Notes |
|--------|------|-------|
| `environment` | string | `server` or `client` |
| `totalSize` | number (bytes) | Total size |
| `compressedSize` | number (bytes) | Compressed size |
| `fileCount` | number | Output file count |

## Report catalog

### `nextbundle.summary`
Readable overview with:
- routes, sources, output files, chunk parts, and module counts
- server/client breakdown
- top 10 sources by size
- top 10 packages by module count
- sync / async module dependency totals

### `nextbundle.route`
Per-route detail report. Pass `{ route: '/some-route' }`.

## Recommended workflow

### Start with schema + summary

```bash
trace-server load ./next-analyze --alias nextjs
trace-server query nextjs "return pretty(await ds.schema.tables())"
trace-server query nextjs "return await ds.reports.get('nextbundle.summary').pretty()"
```

### Inspect the biggest sources

```js
await ds.tables
  .get('nextbundle.dims.sources')
  .orderBy('totalSize', 'desc')
  .limit(25)
  .table()
```

### Inspect output bundles by environment

```js
await ds.tables
  .get('nextbundle.dims.outputFiles')
  .orderBy('totalSize', 'desc')
  .limit(25)
  .table()
```

### Inspect the module graph

```js
await ds.tables
  .get('nextbundle.dims.modules')
  .orderBy('dependentCount', 'desc')
  .limit(25)
  .table()
```

### Inspect sync + async dependency edges

```js
await ds.tables
  .get('nextbundle.views.moduleDependencies')
  .where('kind', '=', 'sync')
  .limit(50)
  .table()
```

### Inspect per-route sizes

```js
await ds.tables.get('nextbundle.views.routeSizes').table()
```

### Get a route-focused readable report

```js
await ds.reports.get('nextbundle.route').args({ route: '/_not-found' }).pretty()
```

## Useful query patterns

Manual environment summary:

```js
const rows = await ds.tables.get('nextbundle.views.environmentBreakdown').rows();
return rows.map(row => `${row.environment}: ${row.totalSize} bytes across ${row.fileCount} files`).join('\n');
```

Package footprint by total size:

```js
await ds.tables
  .get('nextbundle.views.packageSizes')
  .orderBy('totalSize', 'desc')
  .limit(20)
  .table()
```

Route manifest sanity check:

```js
await ds.tables.get('nextbundle.dims.routes').table()
```

## Files and artifacts

Next.js bundle datasets currently expose tables / reports / namespace helpers only. There are no file export collections for this adapter.
