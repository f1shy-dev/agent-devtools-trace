# Unified Dataset Kernel Spec

Status: Draft / confirmed direction

This document captures the final confirmed ideas discussed for replacing the current `trace-server` architecture with a general-purpose dataset analysis kernel.

The intent is to preserve all major ideas from the discussion so they are not lost.

---

## 0. Final Confirmed Ideas

These are the decisions currently considered confirmed unless explicitly changed later.

1. **No backward compatibility is required.**
   - Existing adapter APIs, CLI shapes, endpoint shapes, and query globals may all be removed.
   - We are optimizing for the right long-term architecture, not incremental compatibility.

2. **The system will be redesigned around a dataset kernel, not format adapters with custom endpoints.**
   - The current `TraceAdapter<T>` model is too narrow.
   - The replacement will use **source drivers**, **dataset sessions**, **lazy layers**, and **model packs**.

3. **All query evaluation will happen against one stable root object: `ds`.**
   - No more ad hoc globals like `events`, `trace`, `byName`, etc. as the core API.
   - Domain-specific conveniences may exist under namespaces, but `ds` is the stable entry point.

4. **Lazy layers are a first-class primitive.**
   - Datasets should load cheaply.
   - Expensive derived views should build only when queried.
   - Layers must support dependency tracking, memoization, cancellation, cache metadata, and eviction.

5. **The system must support multiple deep domains with the same architectural quality.**
   - DevTools traces
   - OTEL / OTLP datasets
   - Sentry artifacts
   - Bundle analyzer outputs
   - Raw/untyped data mode

6. **Raw data and semantic derived data must coexist in the same query runtime.**
   - The agent should be able to query raw facts, normalized facts, semantic dimensions, derived views, and reports from one place.
   - We want stacked access, not an either/or choice.

7. **Artifacts/files/workspace are first-class concepts.**
   - Logical artifacts (screenshots, source text, source maps, etc.)
   - Materialized files/directories on disk
   - Managed scratch/export workspace for loaders, layers, and agents

8. **Provenance is mandatory.**
   - Derived rows and reports should be able to reference the raw event/document rows they came from.
   - The agent must be able to trust and audit answers.

9. **Lossless ID handling is mandatory.**
   - Large IDs must not silently lose precision.
   - Canonical string IDs should be used where necessary.

10. **Raw mode is a first-class product, not just a fallback.**
    - It should provide schema inference, path cataloging, inferred tables, samples, and extractable blobs/files.

11. **DevTools is the first implementation target, but not the architectural center of gravity.**
    - DevTools is the proving ground because it is very rich.
    - The final design must remain domain-general.

12. **Generic tables, reports, blobs, and exports will replace most format-specific endpoints.**
    - Adapter-specific HTTP endpoints are not the long-term core abstraction.

13. **The implementation target is Node-first, not Bun-first.**
    - Bun-specific runtime APIs are not part of the intended long-term architecture.
    - Bun may be used opportunistically as a package manager or optional fast path, but the runtime must work cleanly on Node.

14. **The server will use raw Node HTTP and a small custom router.**
    - We do not currently intend to base the kernel on Hono, itty-router, or similar frameworks.
    - The route surface is small enough that a small custom router is preferable.

15. **Query evaluation will be JavaScript-first, with optional TypeScript syntax support.**
    - The runtime query model should not depend on TypeScript types.
    - TS syntax support may still be offered through a fast transpilation step.

16. **Transpilation should use a fast runtime transpiler rather than TypeScript as the primary engine.**
    - `esbuild` is the preferred default runtime transpiler.
    - `typescript` can remain as a compatibility fallback.

17. **Packaging should produce bundled runtime outputs rather than distributing the project as a large tree of source files.**
    - The project should have an explicit build step for packaging.
    - `esbuild` is the intended packaging/bundling tool.
    - The long-term publish shape should center on bundled `dist/` entrypoints rather than shipping the internal source tree.

---

## 1. Why This Exists

The current codebase is a useful proof of concept for load-once/query-many analysis, but it is too limited for the data we actually observed in real traces.

Across the reviewed DevTools traces, we found that the raw data contains much more than the current adapter surface exposes.

Examples of data present in reviewed traces:
- screenshots
- frame pipeline / compositor benchmark data
- event timing / interaction latency data
- CPU profile chunks
- network timing with headers and connection metadata
- inline script source text
- source maps
- original sources embedded in `sourcesContent`
- layout shifts
- soft navigation data
- worker and frame metadata
- render instrumentation encoded in user timing
- V8 source rundown events
- stack trace capture events

The current model exposes only a small hand-curated set of heuristic endpoints and a flat query context. That is not sufficient for high-depth agent workflows.

This spec defines a replacement architecture.

---

## 2. High-Level Goals

### 2.1 Primary goals
- Make large analysis artifacts queryable in a **load-once/query-many** workflow.
- Let agents discover what data exists in a dataset without reverse-engineering the format each time.
- Support both:
  - **raw/fact-level inspection**
  - **semantic/high-level analysis**
- Make repeated analysis cheap through lazy caching and reusable derived layers.
- Support artifact extraction and file materialization in a managed way.
- Preserve provenance across all derived outputs.

### 2.2 Architectural goals
- Domain-general core architecture
- Rich domain-specific packs
- Async-first query runtime
- Lossless IDs and canonical units
- Explicit layer graph with dependency management
- Generic API surface that can be extended without format-specific hacks

### 2.3 Product goals
- Be excellent for DevTools traces
- Be equally principled for OTEL, Sentry, bundle outputs, and raw mode
- Make agent workflows dramatically easier than writing one-off scripts

---

## 3. Non-Goals

- Backward compatibility with the current adapter API
- Backward compatibility with existing CLI commands/endpoints/query globals
- Designing around the current code layout if it prevents a better kernel design
- Restricting the system to trace analysis only

---

## 4. Problems With the Current System

The current architecture is roughly:
- detect format with adapter
- parse file eagerly
- build some indexes eagerly
- expose adapter-specific endpoints
- inject a flat query context into the VM

This has several limitations:

1. **Adapter-specific endpoint APIs do not scale.**
   - They are manageable for a few heuristics.
   - They are not a durable foundation for many domains.

2. **`buildQueryContext()` kills discoverability and laziness.**
   - It provides ad hoc globals.
   - It discourages layered modeling.
   - It does not expose a stable system API.

3. **Too much semantic reconstruction is left to the agent.**
   - Cross-model joins are custom every time.
   - The same analyses must be rediscovered repeatedly.

4. **It does not scale to other deep domains cleanly.**
   - OTEL and Sentry are not just “another adapter with a few endpoints”.

5. **There is no first-class artifact/file/workspace system.**
   - This makes screenshots, source text, sourcemaps, extracted bodies, and generated outputs awkward.

6. **No explicit layer graph exists.**
   - Expensive derived structures are either eager or hand-built ad hoc.

7. **No explicit provenance model exists.**
   - Derived outputs do not uniformly explain what raw rows they came from.

---

## 5. Findings From Reviewed DevTools Traces

We reviewed multiple traces from `~/Downloads/*Trace*.json.gz` plus one uncompressed JSON trace.

### 5.1 Key observations
- Some traces are interaction-heavy.
- Some traces are frame/screenshot-heavy.
- Some traces are source/sourcemap-heavy.
- Some traces contain large inline script text payloads.
- Some traces contain many embedded sourcemaps and source contents.
- Some traces contain render instrumentation via user timing.
- Not all traces contain the same high-level signals.

### 5.2 Representative richness observed
Across reviewed gz traces we found examples like:
- ~239k to ~2.09M events
- ~179 to ~450 screenshots
- ~1.3k to ~14.3k `ProfileChunk` events
- 0 to 392 sourcemaps in metadata
- 0MB to ~40MB inline script source text
- 0MB to ~24MB original `sourcesContent`
- 0 to 6212 `EventTiming` rows
- 0 to 22 `LayoutShift` rows
- 0 to 22 `SoftNavigation` rows
- 5 to 856 network requests

### 5.3 Example concrete finding from one interaction-heavy trace
From one trace we inspected in detail:
- bad interaction around ~232ms total latency
- main `click` dispatch around ~201.8ms
- ~736 render measures in that interaction window
- repeated rerenders in components like `VirtualItem`, `ChatBlock`, `ToolCallAccordion`
- many dropped frame states during the interaction
- significant React / scheduler JS hot spots

This demonstrated that the trace contained enough information to explain the interaction, but the current surface made correlation unnecessarily hard.

### 5.4 Conclusion
DevTools traces are not “just arrays of timeline events”. They are rich multi-model datasets that deserve a real semantic kernel.

---

## 6. What Actually Exists Inside DevTools Traces

From first principles, a DevTools trace is a collection of partially-overlapping event systems.

### 6.1 Common raw event fields
Most raw events may expose:
- `name`
- `cat`
- `ph`
- `pid`
- `tid`
- `ts`
- `dur`
- `id`
- `s`
- `args`

### 6.2 Phase families
Different `ph` values imply different semantics.

Observed phase families include:
- `X` duration slices
- `I` instant events
- `M` metadata events
- `b` / `e` async/nestable pairs
- `s` / `f` flow or async link phases
- `n` async instants / chain points
- `P` CPU profile chunks
- `N` / `D` object lifecycle-ish events

### 6.3 Metadata layer
Observed metadata includes:
- `thread_name`
- `process_name`
- `process_uptime_seconds`

Top-level metadata observed includes:
- `enhancedTraceVersion`
- `source`
- `startTime`
- `dataOrigin`
- `hostDPR`
- `sourceMaps`
- `modifications`

### 6.4 Input/interaction data
Observed event families include:
- `EventTiming`
- `EventDispatch`
- `InputLatency::*`
- `WidgetBaseInputHandler::OnHandleInputEvent`

These contain overlapping representations of user actions.

### 6.5 Frame/compositor data
Observed event families include:
- `PipelineReporter`
- `BeginFrame`
- `RequestMainThreadFrame`
- `BeginImplFrameToSendBeginMainFrame`
- `SendBeginMainFrameToCommit`
- `AnimationFrame`
- `AnimationFrame::Render`
- `AnimationFrame::StyleAndLayout`
- `AnimationFrame::Presentation`

### 6.6 CPU profile data
Observed event families include:
- `Profile`
- `ProfileChunk`

Payloads can contain:
- `cpuProfile.nodes`
- `samples`
- `timeDeltas`
- `lines`
- `columns`
- `trace_ids`

### 6.7 Network/loading data
Observed event families include:
- `ResourceSendRequest`
- `ResourceReceiveResponse`
- `ResourceReceivedData`
- `ResourceFinish`
- `ResourceMarkAsCached`
- `ResourceRequestSender::*`

Payloads may contain:
- `requestId`
- `url`
- `headers`
- `timing`
- `statusCode`
- `protocol`
- `mimeType`
- cache and service worker flags

### 6.8 Screenshot data
Observed event families include:
- `Screenshot`

Payloads may contain:
- `snapshot`
- `frame_sequence`
- `expected_display_time`
- `source_id`

### 6.9 Layout/paint/navigation data
Observed event families include:
- `LayoutShift`
- `SoftNavigation`
- `SoftNavigationHeuristics::*`
- `SoftNavigationContext::*`
- viewport/paint timing events

### 6.10 Render instrumentation via user timing
Observed families include:
- `blink.user_timing`
- `UserTiming::Measure`

These often encode structured JSON strings describing component/render behavior.

### 6.11 Script/source/code data
Observed event families include:
- `ScriptCompiled`
- `ScriptCatchup`
- `LargeScriptCatchup`
- `StubScriptCatchup`
- `TooLargeScriptCatchup`
- `V8StackTraceImpl::capture`

These can include:
- `scriptId`
- `url`
- `sourceText`
- execution context info
- inline source text blobs

### 6.12 Source map metadata
Some traces contain `metadata.sourceMaps[]` with:
- `url`
- `sourceMapUrl`
- `sourceMap`

Some source maps include:
- `sources`
- `sourcesContent`
- `mappings`
- `x_google_ignoreList`

### 6.13 Conclusion
DevTools traces are multi-dimensional datasets containing enough information to answer much richer questions than the current API supports.

---

## 7. Core Architectural Direction

The system will be re-architected around the following top-level components:

1. **Source drivers**
2. **Dataset sessions**
3. **Dataset kernel**
4. **Lazy layers**
5. **Model packs**
6. **Query runtime**
7. **Artifacts/files/workspace subsystem**

---

## 8. Core Concepts

### 8.1 Source driver
A source driver detects and opens one kind of input artifact.

Examples:
- DevTools trace driver
- OTEL/OTLP driver
- Sentry dataset driver
- Next bundle analysis driver
- Raw JSON/NDJSON/CSV driver

### 8.2 Dataset session
A dataset session represents one loaded source artifact in the running server.

It owns:
- dataset manifest
- dataset kind
- source metadata
- kernel
- layer registry/cache
- query runtime factory
- lifecycle / cleanup hooks

### 8.3 Dataset kernel
The kernel is the runtime substrate shared by all dataset kinds.

It owns:
- layer host
- schema/catalog
- raw store
- table registry
- report registry
- artifact store
- file materializer
- workspace manager
- capability registry

### 8.4 Model pack
A model pack augments a dataset with reusable domain or cross-domain structure.

Examples:
- `devtools.*`
- `otel.*`
- `sentry.*`
- `bundle.*`
- `raw.*`
- `code.*`
- `network.*`
- `graph.*`

### 8.5 Layer
A layer is a memoized build unit with dependencies.

Examples:
- parse ingest facts
- normalized request dimension
- render measure view
- source map registry
- interaction report helper cache

---

## 9. Core Public Query Object: `ds`

Every query will execute against one stable root object:

```ts
const ds
```

This object is the main query surface.

### 9.1 Top-level shape

```ts
interface DatasetQueryApi {
  caps: CapabilityApi;
  schema: SchemaApi;
  raw: RawApi;
  tables: TableApi;
  reports: ReportApi;
  artifacts: ArtifactApi;
  files: FileApi;
  workspace: WorkspaceApi;
  layers: LayerDebugApi;
  tools: UtilityApi;
  ns: NamespaceApi;
}
```

### 9.2 Meaning of sections
- `caps`: feature detection for the dataset
- `schema`: discoverability, catalogs, available tables/reports/paths
- `raw`: lossless source-level access
- `tables`: normalized facts, dimensions, views
- `reports`: opinionated summaries and explainers
- `artifacts`: logical blobs
- `files`: materialized files/directories on disk
- `workspace`: managed scratch/export areas
- `layers`: lazy-layer inspection/debugging
- `tools`: generic helpers
- `ns`: domain namespaces, e.g. `devtools`, `otel`, `bundle`, `raw`

### 9.3 Namespace approach
The runtime should support both:
- generic string-driven access
- ergonomic domain namespaces

Examples:

```ts
await ds.tables.get("devtools.dims.interactions").rows()
await ds.reports.run("devtools.interaction", { id: "4758" })
```

and optionally:

```ts
await ds.ns.devtools.interactions.rows()
await ds.ns.devtools.report.interaction("4758")
```

The generic string-based APIs are the stable minimum; namespace sugar can sit on top.

---

## 10. Source Drivers

### 10.1 Direction
Replace the current adapter model with source drivers.

### 10.2 Proposed shape

```ts
interface SourceDriver {
  id: string;
  detect(source: SourceProbe): Promise<Detection | null>;
  open(source: SourceHandle, detection: Detection): Promise<DatasetSession>;
}
```

### 10.3 Responsibilities
A driver is responsible for:
- recognizing input shape
- opening raw source access
- registering initial layers/model packs
- producing a dataset session

A driver is **not** responsible for:
- owning the entire public API surface
- hardcoding the query context globals
- being the main endpoint routing abstraction

---

## 11. Dataset Session / Kernel

### 11.1 Proposed shape

```ts
interface DatasetSession {
  id: string;
  kind: string;
  manifest: DatasetManifest;
  kernel: DatasetKernel;
  createQueryRuntime(options?: QueryRuntimeOptions): QueryRuntime;
  dispose(): Promise<void>;
}
```

```ts
interface DatasetKernel {
  layers: LayerHost;
  schema: SchemaRegistry;
  tables: TableRegistry;
  reports: ReportRegistry;
  artifacts: ArtifactStore;
  files: FileMaterializer;
  workspace: WorkspaceManager;
  caps: CapabilityRegistry;
  raw: RawStore;
}
```

### 11.2 Manifest
The manifest should include things like:
- dataset id
- kind
- source path(s)
- source size
- detected features
- loaded timestamp
- maybe content hashes

---

## 12. Lazy Layer System

### 12.1 Why it exists
Lazy layers solve the core problem:
- datasets can be large and rich
- not every query needs every derived structure
- repeated queries should reuse derived work

### 12.2 Layer types
We discussed the following useful categories:
- **ingest**
- **facts**
- **dims**
- **views**
- **indexes**
- **reports**

### 12.3 Proposed layer shape

```ts
interface LayerSpec<T> {
  key: string;
  deps?: string[];
  when?: (caps: CapabilitySet) => boolean;
  scope?: "session" | "query";
  weight?: "light" | "heavy";
  build(ctx: LayerContext): Promise<T>;
}
```

### 12.4 Layer host behavior
The layer host should support:
- dependency resolution
- deduped concurrent builds
- memoization
- build metadata
- cancellation
- cache eviction for heavy layers
- lazy build only on access

### 12.5 Example flow
A call to:

```ts
await ds.reports.run("devtools.interaction", { id: "4758" })
```

might lazily build:
- `devtools/facts.events`
- `devtools/indexes.common`
- `devtools/dims.interactions`
- `devtools/views.renderMeasures`
- `devtools/views.framePipeline`
- `devtools/views.mainThreadTasks`

but not build unrelated layers like full source map resolution unless needed.

### 12.6 Parameterization rule
Layers should usually be parameter-free reusable units.

Good:
- `devtools/dims.interactions`
- `devtools/views.renderMeasures`

Bad:
- a unique cached layer per interaction ID

Parameterized reports should be computed over reusable layers, not stored as an exploding layer key space.

---

## 13. Query Runtime / Eval Flow

### 13.1 Direction
The current `buildQueryContext()` approach should be removed.

### 13.2 New flow
1. Client sends query
2. Session creates a query runtime
3. Query runtime exposes one root object: `ds`
4. Query executes in async context
5. Layer builds happen lazily through `ds`
6. Timeout aborts both VM execution and in-flight async layer work

### 13.3 Important constraints
- Query runtime must be **async-first**
- Lazy layer calls must be `await`-able
- Timeout must propagate into layer builds and file reads

### 13.4 Proposed context shape
The VM context should contain:
- `ds`
- safe utilities like `console`, `performance`, timers, `URL`, `TextEncoder`, etc.

The dataset itself should be accessed through `ds`, not flattened globals.

### 13.5 Table/query ergonomics
The first implementation may use JS-driven table operations, but the API should be shaped so pushdown is possible later.

We should avoid committing to “always return giant arrays” as the only model.

---

## 14. Schema / Catalog / Discoverability

### 14.1 Why it matters
One of the biggest pain points in rich artifacts is simply discovering what is present.

### 14.2 Required capabilities
`ds.schema` should support:
- list namespaces
- list tables
- list reports
- describe capabilities
- discover field paths
- return sample values
- describe columns / units / IDs

### 14.3 Example API

```ts
await ds.schema.namespaces()
await ds.schema.tables()
await ds.schema.reports()
await ds.schema.describeTable("devtools.dims.interactions")
await ds.schema.paths()
await ds.schema.samples("raw.events.args.data.timing")
```

### 14.4 Raw mode importance
This catalog/discoverability layer is especially important for raw mode and unknown/untyped inputs.

---

## 15. Tables, Facts, Dimensions, Views, Reports

### 15.1 Layered data model
The system should expose data in layers:

1. raw data
2. normalized facts
3. dimensions/entities
4. reusable views
5. reports/explainers

### 15.2 Why this layering matters
It allows:
- raw inspection when needed
- reusable semantic structures
- principled derivations
- agent-friendly analysis without hiding the source facts

### 15.3 Core table categories
- `raw.*`
- `facts.*`
- `dims.*`
- `views.*`

### 15.4 Reports
Reports should be opinionated helpers built on top of reusable layers. They should never be the only way to access underlying data.

### 15.5 Provenance rule
Rows in dimensions/views/reports should preserve or reference provenance to raw inputs.

---

## 16. Provenance

Provenance is required across the system.

### 16.1 Provenance should include
- raw row/event IDs
- source artifact references
- originating layer key
- possibly transformation notes

### 16.2 Why it matters
- debugging
- trust
- agent auditability
- report explainability

### 16.3 Rule
No major derived semantic object should be impossible to trace back to its raw origin.

---

## 17. Lossless IDs and Unit Normalization

### 17.1 Lossless IDs
Some datasets use large IDs that may overflow JS number precision.

Examples include:
- trace IDs
- frame trace IDs
- isolate IDs
- other runtime or distributed tracing IDs

Rule:
- canonicalize risky IDs as strings
- do not silently lose precision

### 17.2 Unit normalization
Across domains we may encounter:
- ns
- µs
- ms
- s
- bytes
- KB/MB/GB
- relative timestamps
- wall-clock timestamps

Rule:
- facts tables should expose canonical normalized units
- original raw values should remain accessible

---

## 18. Artifacts, Files, and Workspace

This is a first-class subsystem.

### 18.1 Artifacts
Logical payloads that exist in a dataset but are not necessarily materialized to disk.

Examples:
- screenshot bytes
- inline script source text
- sourcemap JSON
- original source file contents
- generated flamegraph SVG
- network response body

### 18.2 Files
Materialized on-disk outputs derived from artifacts.

Examples:
- screenshot JPEG files
- exported script files
- exported source tree
- exported sourcemaps

### 18.3 Workspace
Managed scratch/export storage used by:
- loaders
- layer builders
- reports
- agents

### 18.4 Required API surface
- `ds.artifacts`
- `ds.files`
- `ds.workspace`

### 18.5 Why this matters
This supports both:
- agent-visible exports
- internal scratch space for analysis and loaders

---

## 19. Artifact Store

### 19.1 Direction
Artifacts are logical refs to typed payloads.

### 19.2 Example artifact kinds
- text
- json
- image
- binary

### 19.3 Example shape

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

### 19.4 Required operations
- get artifact metadata
- read bytes
- read text
- read JSON
- list artifacts by filter

---

## 20. File Materialization

### 20.1 Direction
Artifacts must be exportable as files/directories in a managed way.

### 20.2 Operations
- materialize one artifact as a file
- export a collection as a directory
- return stable paths + manifest metadata
- allow leases/pinning/release

### 20.3 Collection model
Model packs should be able to register exportable file collections.

Examples:
- `devtools.screenshots`
- `devtools.scripts`
- `code.sources`
- `code.source-maps`
- `devtools.network-bodies`

### 20.4 Manifest rule
Every exported directory should include a manifest mapping files back to artifacts and dataset metadata.

---

## 21. Workspace Management

### 21.1 Direction
Workspace is the managed temp/scratch/export environment.

### 21.2 Use cases
- loader scratch
- decompression scratch
- derived report scratch
- agent-visible exports
- temporary generated analysis files

### 21.3 Required features
- allocate scratch dir
- allocate scratch file
- list/manage export roots
- leases / pin / release
- cleanup / TTL / quotas

### 21.4 Safety rules
- sanitized paths
- no path traversal
- read-only exports by default where appropriate
- managed cleanup

---

## 22. Content-Addressed Storage (CAS)

A global or semi-global content-addressed blob store is strongly recommended.

### 22.1 Why
It avoids repeatedly storing the same:
- screenshots
- source texts
- source maps
- sourcesContent blobs
- generated artifacts

### 22.2 Pattern
- artifact bytes stored by hash in CAS
- exports are lightweight views / links / copies with manifests

---

## 23. DevTools Domain Pack

DevTools is the first implementation target and the richest immediate proving ground.

### 23.1 DevTools capabilities to detect
Examples:
- screenshots available
- CPU profile data available
- EventTiming available
- frame pipeline data available
- network timing available
- source rundown/source text available
- source maps available
- sourcesContent available
- user timing render instrumentation available
- layout shift available
- soft navigation available

### 23.2 Raw layer
Should expose raw trace access and metadata.

Examples:
- raw event rows
- raw metadata
- raw path samples

### 23.3 Facts layers
Normalize raw events into reusable facts.

Examples:
- event rows with canonical columns
- instant event table
- slice event table
- async/flow facts
- CPU sample facts
- object lifecycle facts

Canonical extracted columns should be considered for common nested fields like:
- frame ID
- request ID
- script ID
- interaction ID
- trace/sample ID
- node ID
- task ID
- frame sequence ID
- URL

### 23.4 Index layers
Examples:
- by name
- by category
- by phase
- by thread
- by request ID
- by script ID
- by interaction ID
- by frame sequence ID
- by node ID
- by URL

### 23.5 Dimension layers
Examples:
- threads
- processes
- frames
- requests
- interactions
- tasks
- scripts
- source maps
- original sources
- screenshots
- layout shifts
- soft navigations
- workers
- layers

### 23.6 View layers
Examples:
- frame pipeline
- main-thread tasks
- render measures
- code hotspots
- network waterfall
- visual changes
- interaction windows

### 23.7 Report layers
Examples:
- interaction report
- request report
- frame report
- script report
- soft navigation report

### 23.8 Artifact collections
Examples:
- screenshots
- scripts
- source maps
- original sources
- network bodies

---

## 24. DevTools Tables / Views / Reports We Explicitly Want

### 24.1 Interactions
The trace showed a strong need for first-class interaction modeling.

Desired table/report coverage:
- deduped interaction entities
- grouped input representations (`pointerup`, `mouseup`, `click`, etc.)
- total latency
- dispatch latency
- render count
- dropped frame count
- related JS hot spots
- related layout/paint
- related screenshots

### 24.2 Render measures
Desired support:
- decoded user timing render rows
- joined begin/end/measure semantics
- parsed detail JSON
- component names / track / prop instability
- aggregation by component
- render measures scoped to time windows or interactions

### 24.3 Frame pipeline
Desired support:
- frame sequence correlation
- dropped/presented states
- benchmark stage timings
- relation to screenshots and interactions

### 24.4 Code/source model
Desired support:
- scripts dimension
- inline source text artifacts
- source maps dimension
- original source files dimension
- source-backed hotspot attribution

### 24.5 Requests/network
Desired support:
- lifecycle correlation by request ID
- headers/timing/protocol/cache info
- raw bodies when available
- relation to screenshots/interactions when useful

### 24.6 Layout shifts / soft navigation
Desired support:
- clustered shift entities
- impacted nodes / rects
- relation to interaction windows
- soft navigation contexts and task IDs

---

## 25. Cross-Domain Design: OTEL, Sentry, Bundle, Raw

The architecture must support deep semantic modeling for multiple domains.

### 25.1 OTEL / OTLP
Possible dims/views/reports:
- resources
- scopes
- spans
- links
- logs
- metrics
- service graph
- trace graph
- latency summaries
- error hot spots
- file/artifact exports for related payloads

### 25.2 Sentry
Possible dims/views/reports:
- issues
- events
- transactions
- breadcrumbs
- exceptions
- threads
- stack frames
- release artifacts
- suspect code
- report surfaces for issues/transactions

### 25.3 Bundle analyzer
Possible dims/views/reports:
- modules
- chunks
- assets
- routes
- dependency graph
- duplication analysis
- route size reports
- module hot spots

### 25.4 Raw mode
Raw mode is a first-class domain.

Desired support:
- schema inference
- path cataloging
- inferred tables
- samples
- time field detection
- extractable embedded blobs
- generic exports

---

## 26. Domain-Neutral Packs

We explicitly discussed that some packs should be reusable across domains rather than tightly coupled to one dataset kind.

Examples:
- **code pack**
  - scripts
  - source maps
  - original sources
  - source-backed attribution

- **network pack**
  - request/response modeling
  - timing and protocol info

- **graph pack**
  - relations and edges
  - parent/child/dependency graph operations

- **artifact/file pack**
  - artifact registry
  - export collections
  - file materialization

- **raw schema/catalog pack**
  - path discovery
  - type summaries
  - inferred table helpers

This helps keep the architecture generic and composable.

---

## 27. Relations / Edges

We identified that graph relations are important and should be treated as a real reusable concept.

Examples:
- DevTools: event -> script -> source map -> source -> interaction -> frame
- OTEL: span -> parent span -> service -> resource -> log
- Bundle: module -> chunk -> route
- Sentry: event -> stack frame -> source map -> source

The system should make it easy to model and query edges without forcing everything into flat tables only.

---

## 28. Generic HTTP / CLI Direction

The current adapter-specific endpoints are not the target architecture.

### 28.1 Generic HTTP routes
Representative long-term routes could include:
- session caps
- session schema
- session tables registry
- session reports registry
- generic table queries
- generic report execution
- artifact access
- file export access
- generic query execution

### 28.2 Generic CLI direction
Representative long-term commands could include:
- `schema`
- `tables`
- `report`
- `query`
- `artifact`
- `export`
- `status`

Domain-specific aliases can exist, but generic commands are the architectural center.

---

## 29. Storage Model

To support large rich datasets, we should not rely only on large nested JS objects.

A useful physical model is:

### 29.1 Raw store
Stores raw source-level material.

Examples:
- raw event arrays
- raw documents
- raw metadata

### 29.2 Fact store
Stores normalized rows/columns suitable for query layers.

### 29.3 Blob store
Stores heavy payloads out-of-line.

Examples:
- screenshots
- source text
- source maps
- original source contents
- response bodies

### 29.4 Catalog store
Stores schema/path/type/statistical discovery.

---

## 30. Caching, Eviction, and Memory Management

Lazy layers are not sufficient without explicit lifecycle policy.

### 30.1 Required concerns
- heavy layer memory usage
- blob storage size
- export size
- session workspace cleanup
- eviction policy
- TTL or LRU for cold layers

### 30.2 Recommendations
- keep light reusable layers cached
- allow heavy layers to be evicted with metadata retained
- maintain build metadata for debugging
- use CAS for heavy repeated blobs

---

## 31. Timeout, Abort, and Safety Model

The system must support cancellation beyond just VM timeout.

### 31.1 Abort requirements
Timeout should abort:
- query execution
- layer builds
- large file reads
- expensive derived report generation
- exports if needed

### 31.2 Safety requirements
- safe managed export paths
- sanitized filenames
- no path traversal
- controlled workspace roots
- possible quotas and cleanup policies

---

## 32. Multi-Dataset Composition (Future-Friendly)

This was identified as important future headroom.

Examples:
- DevTools trace + bundle output
- Sentry event + release artifacts + source maps
- OTEL traces + logs + metrics loaded separately

This is not required for the first milestone, but the architecture should not make it impossible.

---

## 33. First Implementation Sequence

### Phase 1: Kernel foundation
Build:
- source driver interface
- dataset session + kernel
- layer host
- query runtime with `ds`
- schema/catalog registry
- artifact/file/workspace subsystem

### Phase 2: DevTools ingestion on the new kernel
Build:
- raw DevTools source driver
- raw event store
- basic caps detection
- schema/path discovery
- initial normalized facts

### Phase 3: DevTools semantic layers
Build:
- common indexes
- interactions
- requests
- screenshots
- scripts
- source map/source layers
- frame pipeline
- render measures
- layout shifts / soft navigations

### Phase 4: Generic reports and API surface
Build:
- generic HTTP routes
- generic CLI
- report/table/artifact/export commands

### Phase 5: Raw mode
Build:
- generic raw driver
- schema inference
- inferred tables
- extractable blob support

### Phase 6: OTEL driver
Use OTEL to pressure-test the generality of the architecture.

### Phase 7: Bundle and/or Sentry
Use these to validate graph/code/source/artifact cross-domain capabilities.

---

## 34. What We Intend to Delete / Replace

The following current ideas are expected to be removed or de-emphasized:
- `TraceAdapter<T>` as the main model
- adapter-owned custom endpoint maps as the core abstraction
- `buildQueryContext()` returning arbitrary globals
- flat query contexts as the main API
- format-specific endpoint routing as the center of the design
- eager adapter-owned derived models where lazy reusable layers are better

---

## 35. Questions We Already Answered For Ourselves

### 35.1 Do we care about backward compatibility?
No.

### 35.2 Should raw data and semantic pre-extracted structures coexist?
Yes.

### 35.3 Should DevTools-specific helpers still exist?
Yes, but as model-pack tables/reports/namespaces, not as the fundamental architecture.

### 35.4 Should file extraction be first-class?
Yes.

### 35.5 Should raw mode be first-class?
Yes.

### 35.6 Should the architecture be domain-general from the start?
Yes.

---

## 36. Example Target Query Experience

Examples of the intended style:

```ts
await ds.schema.tables()
```

```ts
await ds.tables.get("devtools.dims.interactions").rows()
```

```ts
await ds.reports.run("devtools.interaction", { id: "4758" })
```

```ts
await ds.files.exportCollection("devtools.screenshots")
```

```ts
await ds.files.materializeArtifact("artifact:devtools:script:26")
```

```ts
await ds.tables.get("code.dims.sources").rows()
```

```ts
await ds.schema.describeTable("raw.inferred.main")
```

These examples intentionally show:
- generic access
- domain-specific data
- file export/materialization
- raw and semantic layers living side by side

---

## 37. Final Summary

The final confirmed direction is:

- Replace the current adapter system with a **dataset kernel**.
- Build all semantics through **lazy layers** and **model packs**.
- Expose one stable query root, **`ds`**.
- Treat **raw data**, **normalized facts**, **semantic dimensions/views**, and **reports** as separate but connected layers.
- Make **artifacts**, **materialized files**, and **workspace management** first-class.
- Preserve **provenance**, **lossless IDs**, and **canonical units**.
- Make **DevTools** the first implementation target, but keep the architecture fully capable of supporting **OTEL**, **Sentry**, **bundle outputs**, and **raw mode** at the same level of depth.

This is the direction we should implement unless a later explicit design review changes it.
