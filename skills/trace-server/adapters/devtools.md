# DevTools dataset guide

Use this guide for Chrome DevTools traces loaded into the dataset kernel. For the complete typed API (method signatures, interfaces, filter operators), see **`../reference.md`**.

Supported inputs:
- `.json`
- `.json.gz`

## What the DevTools pack exposes

### Facts / dimensions
- `devtools.facts.events`
- `devtools.facts.instantEvents`
- `devtools.facts.sliceEvents`
- `devtools.facts.asyncFlows`
- `devtools.facts.objectLifecycles`
- `devtools.facts.cpuSamples`
- `devtools.dims.processes`
- `devtools.dims.threads`
- `devtools.dims.frames`
- `devtools.dims.workers`
- `devtools.dims.layers`
- `devtools.dims.requests`
- `devtools.dims.requestBodies`
- `devtools.dims.screenshots`
- `devtools.dims.interactions`
- `devtools.dims.tasks`
- `devtools.dims.scripts`
- `devtools.dims.layoutShifts`
- `devtools.dims.softNavigations`
- `devtools.dims.cpuNodes`
- `code.dims.sourceMaps`
- `code.dims.sources`

### Views
- `devtools.views.renderMeasures`
- `devtools.views.renderComponentHotspots`
- `devtools.views.interactionRenders`
- `devtools.views.framePipeline`
- `devtools.views.mainThreadTasks`
- `devtools.views.codeHotspots`
- `devtools.views.cpuHotspots`
- `devtools.views.cpuCallTrees`
- `devtools.views.cpuTimeline`
- `devtools.views.interactionCpuHotspots`
- `devtools.views.taskCpuHotspots`
- `devtools.views.interactionWindows`
- `devtools.views.networkWaterfall`
- `devtools.views.layoutShiftClusters`
- `devtools.views.visualChanges`

### Reports
- `devtools.summary`
- `devtools.interaction`
- `devtools.frame`
- `devtools.request`
- `devtools.soft-navigation`
- `devtools.hotspots`
- `devtools.script`

### Export collections
- `devtools.screenshots`
- `devtools.scripts`
- `devtools.network-bodies`
- `code.source-maps`
- `code.sources`

## Recommended workflow

### Start with schema and reports

```bash
trace-server schema <session>
trace-server report <session> devtools.summary --pretty
```

### Then use query for deeper work

Readable interaction summary:

```bash
trace-server query <session> "
return await ds.reports.get('devtools.interaction').args({ id: '4758' }).pretty();
"
```

Top JS hotspots:

```bash
trace-server query <session> "
return await ds.tables
  .get('devtools.views.codeHotspots')
  .select(['functionName', 'totalDurationMs', 'count'])
  .limit(15)
  .table();
"
```

Top CPU hotspots:

```bash
trace-server query <session> "
return await ds.tables
  .get('devtools.views.cpuHotspots')
  .select(['functionName', 'selfTimeMs', 'totalTimeMs', 'sampleCount'])
  .limit(15)
  .table();
"
```

Network waterfall:

```bash
trace-server query <session> "
return await ds.tables.get('devtools.views.networkWaterfall').limit(20).table();
"
```

Render pressure by component:

```bash
trace-server query <session> "
return await ds.tables.get('devtools.views.renderComponentHotspots').limit(20).table();
"
```

### Manual summary pattern

```js
const interaction = await ds.reports.run('devtools.interaction', { id: '4758' });
return [
  `interaction ${interaction.interaction.interactionId} ${interaction.interaction.durationMs.toFixed(1)}ms`,
  `droppedFrames ${interaction.droppedFrames}`,
  `requests ${interaction.requests.length}`,
  `layoutShifts ${interaction.layoutShifts.length}`,
].join('\n');
```

## Good discovery queries

```js
await ds.schema.tables()
await ds.schema.reports()
await ds.schema.paths()
```

```js
await ds.tables.get('devtools.dims.interactions').rows()
await ds.tables.get('devtools.facts.cpuSamples').limit(50).rows()
```

```js
await ds.layers.status()
```

## Files and artifacts

List artifacts:

```js
await ds.artifacts.list()
```

Export screenshots:

```js
await ds.files.exportCollection('devtools.screenshots')
```

Materialize a script:

```js
await ds.files.materializeArtifact('artifact:devtools:script:10')
```
