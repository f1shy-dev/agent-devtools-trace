# Vite bundle analyzer dataset guide

Use this guide for `vite-bundle-analyzer` JSON outputs loaded into the dataset kernel. For the complete typed API (method signatures, interfaces, filter operators), see **`../reference.md`**.

## Generating the trace

Install `vite-bundle-analyzer`:

```bash
npm install -D vite-bundle-analyzer
```

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite'
import { analyzer } from 'vite-bundle-analyzer'

export default defineConfig({
  plugins: [
    analyzer({
      analyzerMode: 'json',   // outputs stats.json to the build output dir
      fileName: 'stats',      // optional: customize filename (default: stats)
    }),
  ],
})
```

### Rollup

```js
import { adapter, analyzer } from 'vite-bundle-analyzer'

export default {
  plugins: [
    adapter(analyzer({ analyzerMode: 'json' }))
  ]
}
```

### Rolldown (Experimental)

```js
import { unstableRolldownAdapter, analyzer } from 'vite-bundle-analyzer'

export default {
  plugins: [
    unstableRolldownAdapter(analyzer({ analyzerMode: 'json' }))
  ]
}
```

### CLI

```bash
npx vite-bundle-analyzer

# For rolldown-vite projects
npx vite-bundle-analyzer -e=rolldown-vite
```

Then build:
```bash
npm run build
```

The analyzer writes `stats.json` to the build output directory (usually `dist/`). Load it:

```bash
trace-server load dist/stats.json --alias mybundle
```

Only `analyzerMode: 'json'` produces a file compatible with this driver. Other modes: `'server'` (live UI), `'static'` (HTML file), or a custom callback function.

Key config options:

| Option | Default | Description |
|--------|---------|-------------|
| `analyzerMode` | `'server'` | `'json'` for this driver |
| `fileName` | `'stats'` | Output filename (without extension) |
| `defaultSizes` | `'stat'` | Default size metric (`'stat'`, `'gzip'`, `'brotli'`) |
| `include` / `exclude` | `[]` | Filter patterns for modules |
| `gzipOptions` / `brotliOptions` | `{}` | Compression options |

Supported inputs:
- `.json`

## What the Vite bundle pack exposes

### Dimensions
- `bundle.dims.chunks`
- `bundle.dims.modules`
- `bundle.dims.packages`
- `bundle.dims.chunkImports`

### Views
- `bundle.views.treemap`
- `bundle.views.largestModules`
- `bundle.views.duplicateModules`

### Reports
- `bundle.summary`

### Namespace helpers
- `ds.ns.bundle.report.summary()`
- `ds.ns.bundle.chunks()`
- `ds.ns.bundle.modules()`
- `ds.ns.bundle.packages()`

## Table catalog

### `bundle.dims.chunks`
One row per output chunk / asset.

| Column | Type | Notes |
|--------|------|-------|
| `chunkId` | string | Filename-based chunk ID |
| `filename` | string | Output filename |
| `label` | string | Display label |
| `isEntry` | boolean | Entry chunk flag |
| `isAsset` | boolean | Non-JS asset flag |
| `parsedSize` | number (bytes) | Stat / parsed size |
| `gzipSize` | number (bytes) | Gzip size |
| `brotliSize` | number (bytes) | Brotli size |
| `mapSize` | number (bytes) | Source map size |
| `importCount` | number | Chunk import count |
| `moduleCount` | number | Leaf module count |

### `bundle.dims.modules`
Flattened leaf source modules from the hierarchical `source` tree.

| Column | Type | Notes |
|--------|------|-------|
| `moduleId` | string | Stable row ID (`chunkId::path`) |
| `chunkId` | string | Parent chunk filename |
| `path` | string | Full source module path |
| `directory` | string | Parent directory |
| `basename` | string | Filename only |
| `parsedSize` | number (bytes) | Stat / parsed size |
| `gzipSize` | number (bytes) | Gzip size |
| `brotliSize` | number (bytes) | Brotli size |
| `isNodeModule` | boolean | Under `node_modules/` |
| `packageName` | string | npm package name when applicable |
| `depth` | number | Directory nesting depth |

### `bundle.dims.packages`
Aggregated package-level footprint.

| Column | Type | Notes |
|--------|------|-------|
| `packageName` | string | npm package name |
| `parsedSize` | number (bytes) | Total parsed size |
| `gzipSize` | number (bytes) | Total gzip size |
| `brotliSize` | number (bytes) | Total brotli size |
| `moduleCount` | number | Number of modules |
| `chunkCount` | number | Number of chunks containing the package |
| `chunks` | string | Comma-separated chunk filenames |

### `bundle.dims.chunkImports`
Chunk-to-chunk import edges.

| Column | Type | Notes |
|--------|------|-------|
| `fromChunk` | string | Importing chunk |
| `toChunk` | string | Imported chunk |

### `bundle.views.treemap`
Flattened source tree for treemap-style inspection.

| Column | Type | Notes |
|--------|------|-------|
| `chunkId` | string | Parent chunk |
| `path` | string | Full tree path |
| `label` | string | Display label |
| `parsedSize` | number (bytes) | Aggregated parsed size |
| `gzipSize` | number (bytes) | Aggregated gzip size |
| `brotliSize` | number (bytes) | Aggregated brotli size |
| `isLeaf` | boolean | Leaf module vs directory |
| `childCount` | number | Direct child count |
| `depth` | number | Tree depth |

### `bundle.views.largestModules`
Top 100 modules pre-sorted by `parsedSize DESC`.

Columns match `bundle.dims.modules`.

### `bundle.views.duplicateModules`
Modules appearing in multiple chunks.

| Column | Type | Notes |
|--------|------|-------|
| `path` | string | Module path |
| `chunkCount` | number | Number of containing chunks |
| `chunks` | string | Comma-separated chunk filenames |
| `totalParsedSize` | number (bytes) | Total duplicate parsed size |

## Report catalog

### `bundle.summary`
Readable overview with:
- total chunks / entry chunks / asset chunks
- total parsed / gzip / brotli sizes
- top 5 chunks by parsed size
- top 5 packages by parsed size
- top 5 modules by parsed size

## Recommended workflow

### Start with schema + summary

```bash
trace-server load ./stats.json --alias vite
trace-server query vite "return pretty(await ds.schema.tables())"
trace-server query vite "return await ds.reports.get('bundle.summary').pretty()"
```

### Find the biggest output chunks

```js
await ds.tables
  .get('bundle.dims.chunks')
  .orderBy('parsedSize', 'desc')
  .table()
```

### Find the biggest source modules

```js
await ds.tables
  .get('bundle.dims.modules')
  .orderBy('parsedSize', 'desc')
  .limit(25)
  .table()
```

### Inspect package footprint

```js
await ds.tables
  .get('bundle.dims.packages')
  .orderBy('parsedSize', 'desc')
  .table()
```

### Inspect duplicate modules across chunks

```js
await ds.tables
  .get('bundle.views.duplicateModules')
  .orderBy('chunkCount', 'desc')
  .table()
```

### Walk the reconstructed source tree

```js
await ds.tables
  .get('bundle.views.treemap')
  .where('chunkId', '=', 'assets/index-Bc2oaLMj.js')
  .orderBy('parsedSize', 'desc')
  .limit(40)
  .table()
```

## Useful query patterns

List available namespace helpers:

```js
Object.keys(ds.ns.bundle)
```

Manual summary focused on node_modules pressure:

```js
const packages = await ds.tables
  .get('bundle.dims.packages')
  .orderBy('parsedSize', 'desc')
  .limit(10)
  .rows();

return [
  'Top packages:',
  ...packages.map(pkg => `${pkg.packageName}: ${pkg.parsedSize} bytes across ${pkg.chunkCount} chunks`),
].join('\n');
```

## Files and artifacts

Bundle analyzer datasets currently expose tables / reports / namespace helpers only. There are no file export collections for this adapter.
