# Next.js Analyze adapter

Use this adapter for Next.js Turbopack bundle analysis output produced by `next experimental-analyze --output`.

## What it analyzes

This adapter loads the directory emitted by Next.js analyze mode, typically at `.next/diagnostics/analyze/data/`. That directory contains:

- `modules.data` — module graph data
- per-route `analyze.data` files — route-specific source and chunk information
- `routes.json` — optional route listing

## Generating the data

Run this in your Next.js project:

```bash
npx next experimental-analyze --output
```

The generated output is typically located at:

```text
.next/diagnostics/analyze/data/
```

## Loading

```bash
trace-server load .next/diagnostics/analyze/data
```

## Built-in heuristics

### `summary`

Shows module count, route count, source count, aggregate sizes, and top sources by size.

```bash
trace-server summary <session-id>
```

### `routes`

Shows per-route breakdown including source count, output file count, chunk part count, and total sizes.

```bash
trace-server routes <session-id>
```

### `modules --route <route> --limit <n>`

Shows top modules sorted by dependency plus dependent count.

```bash
trace-server modules <session-id>
trace-server modules <session-id> --route /about --limit 20
```

### `sizes --route <route>`

Shows size breakdown by output type (`js`, `css`, `json`, `asset`), environment (`client`, `server`), and top output files.

```bash
trace-server sizes <session-id>
trace-server sizes <session-id> --route /about
```

## Query variables

- `modules` — `ModulesData` instance with methods:
  - `.module(i)`
  - `.moduleCount()`
  - `.moduleDependencies(i)`
  - `.moduleDependents(i)`
  - `.asyncModuleDependencies(i)`
  - `.asyncModuleDependents(i)`
  - `.getModuleIndicesFromPath(path)`
- `analyze` — `AnalyzeData` instance for the selected route with methods:
  - `.source(i)`
  - `.sourceCount()`
  - `.chunkPart(i)`
  - `.chunkPartCount()`
  - `.outputFile(i)`
  - `.outputFileCount()`
  - `.sourceRoots()`
  - `.sourceChildren(i)`
  - `.sourceChunkParts(i)`
  - `.outputFileChunkParts(i)`
  - `.getFullSourcePath(i)`
  - `.getSourceIndexFromPath(path)`
  - `.getOwnSizes(i)`
  - `.getRecursiveSizes(i, filter)`
  - `.getSourceFlags(i)`
- `routes` — `string[]`
- `allAnalyze` — `Map<string, AnalyzeData>`

Use `trace-server query <session-id> --route <route> ...` when you need `analyze` bound to a specific route.

## Query examples

Count modules:

```bash
trace-server query "$SESSION" "modules.moduleCount()"
```

Find largest sources:

```bash
trace-server query "$SESSION" --route / '
const sources = [];
for (let i = 0; i < analyze.sourceCount(); i++) {
  const sizes = analyze.getOwnSizes(i);
  if (sizes.size > 0) {
    sources.push({ path: analyze.getFullSourcePath(i), ...sizes });
  }
}
return sources.sort((a, b) => b.size - a.size).slice(0, 10);
'
```

List dependencies of a module:

```bash
trace-server query "$SESSION" '
const indices = modules.getModuleIndicesFromPath("/app/page.tsx");
return indices.flatMap(i => modules.moduleDependencies(i).map(d => modules.module(d)?.path));
'
```

Compare route sizes:

```bash
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

Get client vs server split for a route:

```bash
trace-server query "$SESSION" --route / '
const totals = { client: 0, server: 0 };
for (let i = 0; i < analyze.sourceCount(); i++) {
  const flags = analyze.getSourceFlags(i);
  const sizes = analyze.getOwnSizes(i);
  if (flags.client) totals.client += sizes.size;
  if (flags.server) totals.server += sizes.size;
}
return totals;
'
```

## Agent workflow

A typical bundle-analysis loop is:

1. Generate data with `npx next experimental-analyze --output`
2. Load `.next/diagnostics/analyze/data`
3. Start with `summary`, `routes`, and `sizes`
4. Inspect hotspots with `modules` and route-specific `query --route ...`
5. Compare routes with `allAnalyze`
6. `unload` the session when done
