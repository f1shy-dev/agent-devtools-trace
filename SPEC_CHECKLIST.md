# SPEC Checklist

Legend:
- [x] done
- [ ] open

This checklist tracks the remaining work to fully satisfy `SPEC.md` for the kernel, DevTools, and raw mode before moving on to OTEL.

## 1. Planning / spec hygiene
- [x] `SPEC.md` updated to reflect the dataset-kernel direction
- [x] `SPEC.md` updated with presentation/runtime-first guidance (`pretty`, `table`, manual string building)
- [x] `SPEC.md` updated with a pre-OTEL hardening gate
- [x] `SPEC_CHECKLIST.md` created
- [x] `README.md` updated to match the new runtime/kernel architecture
- [x] agent-facing docs/examples updated to teach `ds`, `pretty`, `table`, and manual string building

## 2. Kernel foundation
- [x] source-driver interface exists
- [x] dataset session/kernel exists
- [x] stable `ds` query root exists
- [x] lazy layer host exists
- [x] generic Node HTTP server + custom router exists
- [x] bundled build outputs exist via `esbuild`
- [x] basic artifact/file/workspace subsystem exists
- [x] generic schema/tables/reports/artifacts/exports routes exist
- [x] layer status inspection exists
- [ ] global/shared CAS exists
- [ ] multi-dataset composition exists

## 3. Query runtime, table algebra, and presentation
- [x] `ds.reports.run(name, args)` exists
- [x] `ds.tables.get(name).rows()` exists
- [x] `ds.tables.get(name).count()` exists
- [x] `ds.schema.paths()` exists
- [x] `ds.schema.samples(path)` exists
- [x] `ds.tables.get(name)` returns a chainable query builder/handle
- [x] formal table query plan exists (`select` / `where` / `orderBy` / `offset` / `limit`)
- [x] filtered count uses the same query-plan surface
- [x] provider pushdown hook exists for direct table-plan execution
- [x] JS fallback plan execution is implemented for all tables
- [x] global `pretty(value)` exists in the query runtime
- [x] global `table(value)` exists in the query runtime
- [x] table query handles expose `.pretty()`
- [x] table query handles expose `.table()`
- [x] report handles/bound invocations expose `.pretty()`
- [x] CLI/runtime share the same presentation helpers instead of duplicating formatting logic
- [x] presentation output is documented and stable enough for agent workflows

## 4. Provenance, lifecycle, and safety
- [x] basic provenance exists in some derived DevTools outputs
- [x] normalized provenance contract exists across major rows/reports
- [x] facts/dims/views/reports consistently expose provenance or provenance refs
- [x] layer metadata includes dependency keys and size estimates where feasible
- [x] layer eviction exists
- [x] layer pin/unpin exists
- [x] export/materialization lease release exists
- [x] workspace cleanup policy exists (TTL and/or quotas)
- [x] operator-visible status explains retained vs evicted layers/exports
- [x] workspace/export lifecycle is considered production-real, not aspirational

## 5. DevTools core loading and dimensions
- [x] raw DevTools loading exists
- [x] raw event access exists
- [x] threads dimension exists
- [x] requests dimension exists
- [x] screenshots dimension exists
- [x] interactions dimension exists
- [x] scripts dimension exists
- [x] source maps dimension exists
- [x] original sources dimension exists
- [x] layout shifts dimension exists (basic)
- [x] soft navigations dimension exists (basic)
- [x] processes dimension exists
- [x] frames dimension exists
- [x] workers dimension exists
- [x] compositor/layer-related dimensions exist where supported by the trace
- [x] tasks dimension is explicit and complete rather than only task-like derived views

## 6. DevTools facts and indexes
- [x] event-centric raw/fact access exists at a basic level
- [x] explicit instant-event facts exist
- [x] explicit slice-event facts exist
- [x] explicit async/flow facts exist
- [x] CPU sample facts exist
- [x] object-lifecycle facts exist where useful
- [x] reusable indexes by name/category/phase/thread exist
- [x] reusable indexes by request ID/script ID/interaction ID/frame sequence/node ID/url exist

## 7. DevTools views and reports
- [x] render measures view exists
- [x] frame pipeline view exists (basic)
- [x] main-thread tasks view exists (basic)
- [x] code hotspots view exists
- [x] CPU hotspots view exists (basic aggregation)
- [x] interaction windows view exists
- [x] visual changes view exists
- [x] `devtools.summary` report exists
- [x] `devtools.interaction` report exists
- [x] `devtools.frame` report exists
- [x] `devtools.request` report exists
- [x] `devtools.script` report exists
- [x] `devtools.soft-navigation` report exists
- [x] `devtools.hotspots` report exists
- [x] render-measure aggregate-by-component views are complete
- [x] render-measure scoped views by interaction/window are complete
- [x] network waterfall view exists
- [x] frame pipeline stage timing extraction is richer than state-level summaries
- [x] interaction/task/frame/request cross-correlation is complete enough to avoid bespoke agent joins
- [x] major DevTools reports have first-class readable renderers

## 8. DevTools CPU profile depth
- [x] CPU hotspot aggregation exists
- [x] `ProfileChunk` streams are decoded into normalized CPU sample facts
- [x] CPU node/frame dimensions are canonicalized
- [x] self time vs total time semantics are implemented
- [x] folded-stack / call-tree derived views exist
- [x] CPU timeline buckets exist
- [x] interaction-scoped CPU hotspot views exist
- [x] task-scoped CPU hotspot views exist
- [x] CPU attribution through scripts/source maps/sources is robust

## 9. DevTools network/body/artifact depth
- [x] request lifecycle correlation exists
- [x] request timing/protocol/header metadata exists at a useful level
- [x] screenshots export collection exists
- [x] scripts export collection exists
- [x] source maps export collection exists
- [x] original sources export collection exists
- [x] network response/request bodies are exposed as artifacts when present
- [x] `devtools.network-bodies` collection exists
- [x] request ↔ body linkage is explicit
- [x] request ↔ interaction / visual-change correlation is stronger

## 10. DevTools layout/soft-navigation depth
- [x] layout shift rows exist
- [x] soft navigation rows exist
- [x] clustered layout-shift entities exist
- [x] impacted nodes/rects are normalized
- [x] soft-navigation task linkage exists
- [x] layout/soft-navigation relation to interactions/frames/screenshots is complete enough for first-class investigation

## 11. Raw mode
- [x] raw JSON driver exists
- [x] raw summary report exists
- [x] path cataloging exists
- [x] path samples exist
- [x] time-field detection exists
- [x] shallow inferred tables exist
- [x] embedded blob extraction exists (basic)
- [x] raw document export exists
- [x] embedded blob export collection exists
- [x] nested-array inferred tables exist
- [x] path-based inferred-table naming is stable and well-specified
- [x] richer type summaries/path stats exist
- [x] wrapper-object blob detection exists
- [x] byte-array blob detection exists
- [x] gzip/base64 text-or-JSON blob detection exists
- [x] media sniffing from magic bytes exists
- [x] blob confidence scoring exists
- [x] richer blob metadata and export manifests exist
- [x] raw summary/path catalogs have first-class readable renderers

## 12. Pre-OTEL hardening gate
- [x] query builder / pushdown-ready table plan is complete
- [x] presentation layer is complete enough for agent workflows
- [x] provenance normalization is complete enough to be relied upon broadly
- [x] layer/workspace lifecycle basics are complete enough to operate confidently
- [x] DevTools completion criteria are met
- [x] raw-mode completion criteria are met
- [x] README/examples/agent docs match the real runtime surface

## 13. Future after the DevTools/raw milestone
- [ ] OTEL driver
- [ ] relations/edges pack
- [ ] global CAS / content-addressed blob store
- [ ] multi-dataset composition
- [ ] Sentry driver
- [ ] bundle-analysis driver on the new architecture
