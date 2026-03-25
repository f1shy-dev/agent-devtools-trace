import { statSync } from "fs";
import { createHash } from "crypto";
import { basename } from "path";
import { DatasetSession } from "../core/dataset-session.js";
import { findEmbeddedBlobs } from "../core/json-introspect.js";
import { pretty as prettyValue, table as tableValue } from "../core/presentation.js";
import { sanitizeFilename } from "../core/workspace.js";
import { readMaybeGzipText } from "../core/io.js";
import type {
  ArtifactData,
  ArtifactProvider,
  FileCollectionProvider,
  SourceDetection,
  SourceDriver,
  SourceProbe,
  TableProvider,
  ReportProvider,
} from "../core/types.js";
import type { ArtifactRef, CapabilityMap } from "../shared/types.js";

interface TraceEvent {
  cat?: string;
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: Record<string, any>;
  id?: string | number;
  s?: string;
}

interface SourceMapEntry {
  url?: string;
  sourceMapUrl?: string;
  sourceMap?: Record<string, any>;
}

interface ParsedTrace {
  metadata: Record<string, any>;
  traceEvents: TraceEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function splitCategories(categoryValue: string | undefined): string[] {
  if (!categoryValue) return [];
  return categoryValue
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function getTraceBounds(events: TraceEvent[]) {
  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.ph === "M" || event.ts <= 0) continue;
    minTs = Math.min(minTs, event.ts);
    maxTs = Math.max(maxTs, event.ts + (event.dur ?? 0));
  }
  return {
    minTs: Number.isFinite(minTs) ? minTs : 0,
    maxTs: Number.isFinite(maxTs) ? maxTs : 0,
  };
}

function parseTracePayload(payload: unknown): ParsedTrace {
  if (Array.isArray(payload)) {
    return { metadata: {}, traceEvents: payload as TraceEvent[] };
  }
  if (!isRecord(payload)) {
    throw new Error("Invalid DevTools trace: expected object or array");
  }
  const traceEvents = payload.traceEvents;
  if (!Array.isArray(traceEvents)) {
    throw new Error("Invalid DevTools trace: missing traceEvents array");
  }
  const metadata = isRecord(payload.metadata)
    ? (payload.metadata as Record<string, any>)
    : Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "traceEvents"));
  return {
    metadata,
    traceEvents: traceEvents as TraceEvent[],
  };
}

async function parseTraceFile(filePath: string): Promise<ParsedTrace> {
  const text = await readMaybeGzipText(filePath);
  try {
    return parseTracePayload(JSON.parse(text));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse DevTools trace: ${message}`);
  }
}

function getThreadKey(pid: number, tid: number) {
  return `${pid}:${tid}`;
}

function buildThreadMetadata(events: TraceEvent[]) {
  const threadNames = new Map<string, string>();
  const processNames = new Map<number, string>();
  for (const event of events) {
    if (event.ph !== "M") continue;
    const name =
      typeof event.args?.name === "string"
        ? event.args.name
        : typeof event.args?.data?.name === "string"
          ? event.args.data.name
          : undefined;
    if (!name) continue;
    if (event.name === "thread_name") threadNames.set(getThreadKey(event.pid, event.tid), name);
    if (event.name === "process_name") processNames.set(event.pid, name);
  }
  return { threadNames, processNames };
}

function getNestedString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function canonicalId(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function buildFacts(trace: ParsedTrace) {
  return trace.traceEvents.map((event, index) => {
    const data = isRecord(event.args?.data) ? (event.args!.data as Record<string, any>) : undefined;
    const endData = isRecord(event.args?.endData)
      ? (event.args!.endData as Record<string, any>)
      : undefined;
    const categories = splitCategories(event.cat);
    return {
      eventId: `evt:${index}`,
      rawIndex: index,
      name: event.name,
      phase: event.ph,
      categories,
      pid: event.pid,
      tid: event.tid,
      threadKey: getThreadKey(event.pid, event.tid),
      tsUs: event.ts,
      durUs: event.dur ?? 0,
      endUs: event.ts + (event.dur ?? 0),
      id: canonicalId(event.id),
      flowScope: canonicalId(event.s),
      args: event.args ?? {},
      frameId:
        getNestedString(data?.frame) ??
        getNestedString((event.args as any)?.frame) ??
        getNestedString((event.args as any)?.beginData?.frame),
      requestId: getNestedString(data?.requestId),
      url:
        getNestedString(data?.url) ??
        getNestedString((event.args as any)?.url) ??
        getNestedString(data?.script_url) ??
        getNestedString(data?.final_response_url),
      scriptId: canonicalId(data?.scriptId),
      interactionId:
        typeof data?.interactionId === "number" && Number.isFinite(data.interactionId)
          ? String(data.interactionId)
          : undefined,
      frameSeqId:
        typeof (event.args as any)?.frameSeqId === "number"
          ? String((event.args as any).frameSeqId)
          : typeof (event.args as any)?.frame_sequence === "number"
            ? String((event.args as any).frame_sequence)
            : typeof data?.frameSeqId === "number"
              ? String(data.frameSeqId)
              : undefined,
      nodeId:
        typeof data?.nodeId === "number"
          ? String(data.nodeId)
          : typeof endData?.nodeId === "number"
            ? String(endData.nodeId)
            : undefined,
      workerId: canonicalId(data?.workerId ?? (event.args as any)?.workerId),
      layerId: canonicalId(data?.layerId ?? (event.args as any)?.layerId),
      sampleTraceId: canonicalId(
        data?.sampleTraceId ?? data?.traceId ?? (event.args as any)?.traceId,
      ),
      provenance: { rawIds: [`evt:${index}`], layer: "devtools/facts.events" },
    };
  });
}

function buildIndexes(events: TraceEvent[]) {
  const byName = new Map<string, TraceEvent[]>();
  const byCategory = new Map<string, TraceEvent[]>();
  const byPhase = new Map<string, TraceEvent[]>();
  const byThread = new Map<string, TraceEvent[]>();
  for (const event of events) {
    if (!byName.has(event.name)) byName.set(event.name, []);
    byName.get(event.name)!.push(event);
    for (const category of splitCategories(event.cat)) {
      if (!byCategory.has(category)) byCategory.set(category, []);
      byCategory.get(category)!.push(event);
    }
    if (!byPhase.has(event.ph)) byPhase.set(event.ph, []);
    byPhase.get(event.ph)!.push(event);
    const threadKey = getThreadKey(event.pid, event.tid);
    if (!byThread.has(threadKey)) byThread.set(threadKey, []);
    byThread.get(threadKey)!.push(event);
  }
  return { byName, byCategory, byPhase, byThread };
}

function buildRequests(trace: ParsedTrace) {
  const requests = new Map<string, any>();
  const facts = buildFacts(trace);
  for (const fact of facts) {
    if (!fact.requestId) continue;
    let row = requests.get(fact.requestId);
    if (!row) {
      row = {
        requestId: fact.requestId,
        url: fact.url ?? "",
        method: "",
        startTimeUs: fact.tsUs,
        endTimeUs: undefined as number | undefined,
        durationMs: undefined as number | undefined,
        statusCode: undefined as number | undefined,
        mimeType: undefined as string | undefined,
        protocol: undefined as string | undefined,
        fromCache: undefined as boolean | undefined,
        fromServiceWorker: undefined as boolean | undefined,
        responseHeaders: [] as Array<{ name: string; value: string }>,
        timing: undefined as Record<string, unknown> | undefined,
        rawEventIds: [] as string[],
      };
      requests.set(fact.requestId, row);
    }
    row.rawEventIds.push(fact.eventId);
    const data =
      fact.args && isRecord((fact.args as any).data)
        ? ((fact.args as any).data as Record<string, any>)
        : undefined;
    if (fact.name === "ResourceSendRequest") {
      row.startTimeUs = fact.tsUs;
      row.url = getNestedString(data?.url) ?? row.url;
      row.method = getNestedString(data?.requestMethod) ?? row.method;
    }
    if (fact.name === "ResourceReceiveResponse") {
      if (typeof data?.statusCode === "number") row.statusCode = data.statusCode;
      row.mimeType = getNestedString(data?.mimeType) ?? row.mimeType;
      row.protocol = getNestedString(data?.protocol) ?? row.protocol;
      if (typeof data?.fromCache === "boolean") row.fromCache = data.fromCache;
      if (typeof data?.fromServiceWorker === "boolean")
        row.fromServiceWorker = data.fromServiceWorker;
      if (Array.isArray(data?.headers)) {
        row.responseHeaders = data.headers.filter(isRecord).map((header) => ({
          name: String(header.name ?? ""),
          value: String(header.value ?? ""),
        }));
      }
      if (isRecord(data?.timing)) row.timing = data.timing as Record<string, unknown>;
    }
    if (fact.name === "ResourceFinish") {
      row.endTimeUs = fact.endUs;
      row.durationMs = (fact.endUs - row.startTimeUs) / 1000;
    }
  }
  return [...requests.values()]
    .map((row) => ({
      ...row,
      provenance: { rawIds: row.rawEventIds, layer: "devtools/dims.requests" },
    }))
    .sort((a, b) => a.startTimeUs - b.startTimeUs || a.requestId.localeCompare(b.requestId));
}

function getScreenshotEvents(trace: ParsedTrace) {
  return trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.name === "Screenshot" && typeof event.args?.snapshot === "string")
    .sort((left, right) => left.event.ts - right.event.ts);
}

function buildScreenshots(trace: ParsedTrace) {
  const { minTs } = getTraceBounds(trace.traceEvents);
  return getScreenshotEvents(trace).map(({ event, index: rawIndex }, screenshotIndex) => {
    const base64 = String(event.args?.snapshot ?? "");
    const bytes = Buffer.from(base64, "base64");
    return {
      screenshotId: String(screenshotIndex),
      artifactId: `artifact:devtools:screenshot:${screenshotIndex}`,
      eventId: `evt:${rawIndex}`,
      index: screenshotIndex,
      rawIndex,
      tsUs: event.ts,
      timestampMs: (event.ts - minTs) / 1000,
      frameSeqId:
        typeof event.args?.frame_sequence === "number"
          ? String(event.args.frame_sequence)
          : undefined,
      expectedDisplayTimeUs:
        typeof event.args?.expected_display_time === "number"
          ? event.args.expected_display_time
          : undefined,
      sizeBytes: bytes.length,
      mediaType: "image/jpeg",
      base64,
      filename: `screenshot-${String(screenshotIndex).padStart(4, "0")}.jpg`,
      provenance: {
        rawIds: [`evt:${rawIndex}`],
        layer: "devtools/dims.screenshots",
        artifactIds: [`artifact:devtools:screenshot:${screenshotIndex}`],
      },
    };
  });
}

function chooseInteractionType(types: string[]) {
  const preference = ["click", "keydown", "pointerup", "mouseup", "pointerdown", "mousedown"];
  for (const candidate of preference) {
    if (types.includes(candidate)) return candidate;
  }
  return types[0] ?? "unknown";
}

function buildInteractions(trace: ParsedTrace) {
  const eventTimingRows = trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.name === "EventTiming" && isRecord(event.args?.data))
    .map(({ event, index }) => {
      const data = event.args!.data as Record<string, any>;
      return {
        eventId: `evt:${index}`,
        tsUs: event.ts,
        type: getNestedString(data.type) ?? "unknown",
        interactionId:
          typeof data.interactionId === "number" && Number.isFinite(data.interactionId)
            ? String(data.interactionId)
            : undefined,
        durationMs: typeof data.duration === "number" ? data.duration : 0,
        processingStartMs:
          typeof data.processingStart === "number" ? data.processingStart : undefined,
        processingEndMs: typeof data.processingEnd === "number" ? data.processingEnd : undefined,
        commitFinishTimeMs:
          typeof data.commitFinishTime === "number" ? data.commitFinishTime : undefined,
        timeStampMs: typeof data.timeStamp === "number" ? data.timeStamp : undefined,
      };
    });

  const groups = new Map<string, typeof eventTimingRows>();
  for (const row of eventTimingRows) {
    const key =
      row.interactionId && row.interactionId !== "0"
        ? row.interactionId
        : `${row.type}@${row.tsUs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return [...groups.entries()]
    .map(([key, rows]) => {
      const primary = rows.sort((a, b) => b.durationMs - a.durationMs)[0]!;
      const types = [...new Set(rows.map((row) => row.type))];
      const startTsUs = Math.min(...rows.map((row) => row.tsUs));
      const endTsUs = Math.max(...rows.map((row) => row.tsUs + row.durationMs * 1000));
      const rawEventIds = rows.map((row) => row.eventId);
      return {
        interactionId: key,
        sourceInteractionId: primary.interactionId,
        type: chooseInteractionType(types),
        eventTypes: types,
        durationMs: Math.max(...rows.map((row) => row.durationMs)),
        startTsUs,
        endTsUs,
        processingStartMs: primary.processingStartMs,
        processingEndMs: primary.processingEndMs,
        commitFinishTimeMs: primary.commitFinishTimeMs,
        timeStampMs: primary.timeStampMs,
        rawEventIds,
        provenance: { rawIds: rawEventIds, layer: "devtools/dims.interactions" },
      };
    })
    .sort((a, b) => b.durationMs - a.durationMs || a.startTsUs - b.startTsUs);
}

function parseDetail(detail: unknown): Record<string, any> {
  if (typeof detail !== "string") return {};
  try {
    const parsed = JSON.parse(detail);
    return isRecord(parsed) ? (parsed as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function buildRenderMeasures(trace: ParsedTrace) {
  const begins = new Map<string, TraceEvent>();
  trace.traceEvents.forEach((event) => {
    if (splitCategories(event.cat).includes("blink.user_timing") && event.ph === "b") {
      const traceId = canonicalId(event.args?.traceId ?? event.args?.data?.traceId);
      if (traceId) begins.set(traceId, event);
    }
  });

  return trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.name === "UserTiming::Measure")
    .map(({ event, index }) => {
      const measureArgs = event.args ?? {};
      const traceId = canonicalId(measureArgs.sampleTraceId ?? measureArgs.traceId);
      const begin = traceId ? begins.get(traceId) : undefined;
      const detail = parseDetail(begin?.args?.detail);
      const properties = Array.isArray(detail.devtools?.properties)
        ? detail.devtools.properties
        : [];
      return {
        renderMeasureId: `render:${index}`,
        eventId: `evt:${index}`,
        traceId,
        componentName: begin?.name ?? undefined,
        tsUs: event.ts,
        durationMs: (event.dur ?? 0) / 1000,
        track: getNestedString(detail.devtools?.track),
        tooltipText: getNestedString(detail.devtools?.tooltipText),
        properties,
        propKeys: properties
          .filter((entry: unknown) => Array.isArray(entry) && typeof entry[0] === "string")
          .map((entry: any[]) => String(entry[0])),
        provenance: {
          rawIds: [`evt:${index}`, ...(begin ? [`evt:${trace.traceEvents.indexOf(begin)}`] : [])],
          layer: "devtools/views.renderMeasures",
        },
      };
    })
    .filter((row) => row.componentName);
}

function buildScripts(trace: ParsedTrace) {
  const scripts = new Map<string, any>();
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps)
    ? (trace.metadata.sourceMaps as SourceMapEntry[])
    : [];

  const ensure = (scriptId: string) => {
    if (!scripts.has(scriptId)) {
      scripts.set(scriptId, {
        scriptId,
        url: undefined as string | undefined,
        hasSourceText: false,
        sourceTextArtifactId: undefined as string | undefined,
        sourceTextBytes: 0,
        sourceMapId: undefined as string | undefined,
        rawEventIds: [] as string[],
      });
    }
    return scripts.get(scriptId)!;
  };

  trace.traceEvents.forEach((event, index) => {
    const data = isRecord(event.args?.data) ? (event.args!.data as Record<string, any>) : undefined;
    const scriptId = canonicalId(data?.scriptId);
    if (!scriptId) return;
    const row = ensure(scriptId);
    row.rawEventIds.push(`evt:${index}`);
    row.url = getNestedString(data?.url) ?? row.url;
    const sourceText = getNestedString(data?.sourceText);
    if (sourceText !== undefined) {
      row.hasSourceText = true;
      row.sourceTextArtifactId = `artifact:devtools:script:${scriptId}`;
      row.sourceTextBytes = sourceText.length;
    }
  });

  for (const row of scripts.values()) {
    if (!row.url) continue;
    const sourceMapIndex = sourceMaps.findIndex((entry) => entry.url === row.url);
    if (sourceMapIndex >= 0) {
      row.sourceMapId = `sourcemap:${sourceMapIndex}`;
    }
  }

  return [...scripts.values()]
    .map((row) => ({
      ...row,
      provenance: {
        rawIds: row.rawEventIds,
        layer: "devtools/dims.scripts",
        artifactIds: row.sourceTextArtifactId ? [row.sourceTextArtifactId] : [],
      },
    }))
    .sort((a, b) => Number(a.scriptId) - Number(b.scriptId));
}

function buildSourceMaps(trace: ParsedTrace) {
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps)
    ? (trace.metadata.sourceMaps as SourceMapEntry[])
    : [];
  return sourceMaps.map((entry, index) => ({
    sourceMapId: `sourcemap:${index}`,
    artifactId: `artifact:code:sourcemap:${index}`,
    url: entry.url,
    sourceMapUrl: entry.sourceMapUrl,
    sourceCount: Array.isArray(entry.sourceMap?.sources) ? entry.sourceMap!.sources.length : 0,
    hasSourcesContent: Array.isArray(entry.sourceMap?.sourcesContent),
    provenance: {
      rawIds: [],
      layer: "code/dims.sourceMaps",
      artifactIds: [`artifact:code:sourcemap:${index}`],
    },
  }));
}

function buildSources(trace: ParsedTrace) {
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps)
    ? (trace.metadata.sourceMaps as SourceMapEntry[])
    : [];
  const rows: any[] = [];
  sourceMaps.forEach((entry, mapIndex) => {
    const sources = Array.isArray(entry.sourceMap?.sources) ? entry.sourceMap!.sources : [];
    const contents = Array.isArray(entry.sourceMap?.sourcesContent)
      ? entry.sourceMap!.sourcesContent
      : [];
    sources.forEach((source, sourceIndex) => {
      const content = typeof contents[sourceIndex] === "string" ? contents[sourceIndex] : undefined;
      rows.push({
        sourceId: `source:${mapIndex}:${sourceIndex}`,
        artifactId:
          content !== undefined ? `artifact:code:source:${mapIndex}:${sourceIndex}` : undefined,
        sourceMapId: `sourcemap:${mapIndex}`,
        sourcePath: source,
        sizeBytes: content?.length ?? 0,
        hasContent: content !== undefined,
        provenance: {
          rawIds: [],
          layer: "code/dims.sources",
          artifactIds:
            content !== undefined ? [`artifact:code:source:${mapIndex}:${sourceIndex}`] : [],
        },
      });
    });
  });
  return rows;
}

function buildThreadRows(trace: ParsedTrace) {
  const { threadNames, processNames } = buildThreadMetadata(trace.traceEvents);
  const counts = new Map<string, number>();
  for (const event of trace.traceEvents) {
    const key = getThreadKey(event.pid, event.tid);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([threadKey, eventCount]) => {
      const [pidText, tidText] = threadKey.split(":");
      const pid = Number(pidText);
      const tid = Number(tidText);
      return {
        threadKey,
        pid,
        tid,
        threadName: threadNames.get(threadKey),
        processName: processNames.get(pid),
        eventCount,
        provenance: { rawIds: [], layer: "devtools/dims.threads" },
      };
    })
    .sort((a, b) => b.eventCount - a.eventCount || a.threadKey.localeCompare(b.threadKey));
}

function buildProcessRows(trace: ParsedTrace) {
  const { processNames } = buildThreadMetadata(trace.traceEvents);
  const rows = new Map<number, { eventCount: number; threadKeys: Set<string>; rawIds: string[] }>();
  trace.traceEvents.forEach((event, index) => {
    if (!rows.has(event.pid)) {
      rows.set(event.pid, { eventCount: 0, threadKeys: new Set(), rawIds: [] });
    }
    const row = rows.get(event.pid)!;
    row.eventCount += 1;
    row.threadKeys.add(getThreadKey(event.pid, event.tid));
    row.rawIds.push(`evt:${index}`);
  });
  return [...rows.entries()]
    .map(([pid, row]) => ({
      processId: String(pid),
      pid,
      processName: processNames.get(pid),
      threadCount: row.threadKeys.size,
      eventCount: row.eventCount,
      provenance: { rawIds: row.rawIds, layer: "devtools/dims.processes" },
    }))
    .sort((a, b) => b.eventCount - a.eventCount || a.pid - b.pid);
}

function buildFrameRows(trace: ParsedTrace) {
  const facts = buildFacts(trace).filter((fact) => fact.frameId);
  const groups = new Map<string, any>();
  for (const fact of facts) {
    if (!groups.has(fact.frameId!)) {
      groups.set(fact.frameId!, {
        frameId: fact.frameId,
        url: fact.url,
        eventCount: 0,
        threadKeys: new Set<string>(),
        rawEventIds: [] as string[],
      });
    }
    const row = groups.get(fact.frameId!)!;
    row.eventCount += 1;
    row.url = row.url ?? fact.url;
    row.threadKeys.add(fact.threadKey);
    row.rawEventIds.push(fact.eventId);
  }
  return [...groups.values()]
    .map((row) => ({
      frameId: row.frameId,
      url: row.url,
      eventCount: row.eventCount,
      threadCount: row.threadKeys.size,
      provenance: { rawIds: row.rawEventIds, layer: "devtools/dims.frames" },
    }))
    .sort(
      (a, b) => b.eventCount - a.eventCount || String(a.frameId).localeCompare(String(b.frameId)),
    );
}

function buildWorkerRows(trace: ParsedTrace) {
  const facts = buildFacts(trace);
  const threadRows = buildThreadRows(trace);
  const groups = new Map<string, any>();
  facts
    .filter((fact) => fact.workerId)
    .forEach((fact) => {
      const key = fact.workerId!;
      if (!groups.has(key)) {
        groups.set(key, {
          workerId: key,
          threadKeys: new Set<string>(),
          urls: new Set<string>(),
          rawEventIds: [] as string[],
        });
      }
      const row = groups.get(key)!;
      row.threadKeys.add(fact.threadKey);
      if (fact.url) row.urls.add(fact.url);
      row.rawEventIds.push(fact.eventId);
    });
  for (const thread of threadRows) {
    if (!/worker/i.test(thread.threadName ?? "") && !/worker/i.test(thread.processName ?? ""))
      continue;
    const key = `thread:${thread.threadKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        workerId: key,
        threadKeys: new Set<string>(),
        urls: new Set<string>(),
        rawEventIds: [] as string[],
      });
    }
    groups.get(key)!.threadKeys.add(thread.threadKey);
  }
  return [...groups.values()]
    .map((row) => ({
      workerId: row.workerId,
      threadCount: row.threadKeys.size,
      urls: [...row.urls].sort(),
      provenance: { rawIds: row.rawEventIds, layer: "devtools/dims.workers" },
    }))
    .sort((a, b) => a.workerId.localeCompare(b.workerId));
}

function buildLayerRows(trace: ParsedTrace) {
  const facts = buildFacts(trace).filter((fact) => fact.layerId);
  const groups = new Map<string, any>();
  for (const fact of facts) {
    const key = fact.layerId!;
    if (!groups.has(key)) {
      groups.set(key, {
        layerId: key,
        eventNames: new Set<string>(),
        rawEventIds: [] as string[],
      });
    }
    const row = groups.get(key)!;
    row.eventNames.add(fact.name);
    row.rawEventIds.push(fact.eventId);
  }
  return [...groups.values()]
    .map((row) => ({
      layerId: row.layerId,
      eventCount: row.rawEventIds.length,
      eventNames: [...row.eventNames].sort(),
      provenance: { rawIds: row.rawEventIds, layer: "devtools/dims.layers" },
    }))
    .sort((a, b) => b.eventCount - a.eventCount || a.layerId.localeCompare(b.layerId));
}

function buildInstantFacts(trace: ParsedTrace) {
  return buildFacts(trace)
    .filter((fact) => ["I", "i", "M", "n"].includes(fact.phase))
    .map((fact) => ({
      ...fact,
      provenance: { rawIds: [fact.eventId], layer: "devtools/facts.instantEvents" },
    }));
}

function buildSliceFacts(trace: ParsedTrace) {
  return buildFacts(trace)
    .filter((fact) => fact.phase === "X")
    .map((fact) => ({
      ...fact,
      provenance: { rawIds: [fact.eventId], layer: "devtools/facts.sliceEvents" },
    }));
}

function buildAsyncFlowFacts(trace: ParsedTrace) {
  return buildFacts(trace)
    .filter(
      (fact) =>
        ["b", "e", "s", "t", "f", "n"].includes(fact.phase) || !!fact.id || !!fact.flowScope,
    )
    .map((fact) => ({
      ...fact,
      provenance: { rawIds: [fact.eventId], layer: "devtools/facts.asyncFlows" },
    }));
}

function buildObjectLifecycles(trace: ParsedTrace) {
  const groups = new Map<string, any>();
  buildFacts(trace)
    .filter((fact) => fact.id || fact.flowScope)
    .forEach((fact) => {
      const objectId = fact.id ?? fact.flowScope!;
      if (!groups.has(objectId)) {
        groups.set(objectId, {
          objectId,
          eventNames: new Set<string>(),
          firstTsUs: fact.tsUs,
          lastTsUs: fact.endUs,
          rawEventIds: [] as string[],
        });
      }
      const row = groups.get(objectId)!;
      row.eventNames.add(fact.name);
      row.firstTsUs = Math.min(row.firstTsUs, fact.tsUs);
      row.lastTsUs = Math.max(row.lastTsUs, fact.endUs);
      row.rawEventIds.push(fact.eventId);
    });
  return [...groups.values()]
    .map((row) => ({
      objectId: row.objectId,
      firstTsUs: row.firstTsUs,
      lastTsUs: row.lastTsUs,
      eventCount: row.rawEventIds.length,
      eventNames: [...row.eventNames].sort(),
      provenance: { rawIds: row.rawEventIds, layer: "devtools/facts.objectLifecycles" },
    }))
    .sort((a, b) => b.eventCount - a.eventCount || a.firstTsUs - b.firstTsUs);
}

function buildSecondaryIndexes(trace: ParsedTrace) {
  const facts = buildFacts(trace);
  const build = (keyOf: (fact: ReturnType<typeof buildFacts>[number]) => string | undefined) => {
    const map = new Map<string, string[]>();
    for (const fact of facts) {
      const key = keyOf(fact);
      if (!key) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(fact.eventId);
    }
    return map;
  };
  return {
    byRequestId: build((fact) => fact.requestId),
    byScriptId: build((fact) => fact.scriptId),
    byInteractionId: build((fact) => fact.interactionId),
    byFrameSequenceId: build((fact) => fact.frameSeqId),
    byNodeId: build((fact) => fact.nodeId),
    byUrl: build((fact) => fact.url),
  };
}

function buildLayoutShifts(trace: ParsedTrace) {
  return trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.name === "LayoutShift" && isRecord(event.args?.data))
    .map(({ event, index }) => {
      const data = event.args!.data as Record<string, any>;
      const impactedNodes = Array.isArray(data.impacted_nodes) ? data.impacted_nodes : [];
      return {
        layoutShiftId: `layout-shift:${index}`,
        eventId: `evt:${index}`,
        tsUs: event.ts,
        score: typeof data.score === "number" ? data.score : 0,
        cumulativeScore: typeof data.cumulative_score === "number" ? data.cumulative_score : 0,
        hadRecentInput: Boolean(data.had_recent_input),
        impactedNodeCount: impactedNodes.length,
        impactedNodeIds: impactedNodes
          .filter(
            (node) =>
              isRecord(node) &&
              (typeof (node as any).node_id === "number" ||
                typeof (node as any).nodeId === "number"),
          )
          .map((node) => String((node as any).node_id ?? (node as any).nodeId)),
        impactedRects: impactedNodes
          .filter(
            (node) =>
              isRecord(node) &&
              (isRecord((node as any).old_rect) || isRecord((node as any).new_rect)),
          )
          .map((node) => ({ oldRect: (node as any).old_rect, newRect: (node as any).new_rect })),
        rawEventIds: [`evt:${index}`],
        provenance: { rawIds: [`evt:${index}`], layer: "devtools/dims.layoutShifts" },
      };
    });
}

function buildSoftNavigations(trace: ParsedTrace) {
  const groups = new Map<
    string,
    {
      startTsUs: number;
      endTsUs: number;
      rawEventIds: string[];
      eventTypes: Set<string>;
      domModifications: number;
    }
  >();
  trace.traceEvents.forEach((event, index) => {
    if (!event.name.startsWith("SoftNavigation")) return;
    const contextId =
      canonicalId((event.args as any)?.context?.softNavContextId) ?? `soft-nav:${index}`;
    if (!groups.has(contextId)) {
      groups.set(contextId, {
        startTsUs: event.ts,
        endTsUs: event.ts,
        rawEventIds: [],
        eventTypes: new Set(),
        domModifications: 0,
      });
    }
    const row = groups.get(contextId)!;
    row.startTsUs = Math.min(row.startTsUs, event.ts);
    row.endTsUs = Math.max(row.endTsUs, event.ts + (event.dur ?? 0));
    row.rawEventIds.push(`evt:${index}`);
    row.eventTypes.add(event.name);
    const modifications = (event.args as any)?.context?.domModifications;
    if (typeof modifications === "number") {
      row.domModifications = Math.max(row.domModifications, modifications);
    }
  });
  const tasks = buildMainThreadTasks(trace);
  return [...groups.entries()]
    .map(([softNavigationId, row]) => {
      const task = tasks.find(
        (candidate) =>
          candidate.tsUs <= row.endTsUs &&
          candidate.tsUs + candidate.durationMs * 1000 >= row.startTsUs,
      );
      return {
        softNavigationId,
        startTsUs: row.startTsUs,
        endTsUs: row.endTsUs,
        durationMs: (row.endTsUs - row.startTsUs) / 1000,
        eventTypes: [...row.eventTypes].sort(),
        eventCount: row.rawEventIds.length,
        domModifications: row.domModifications,
        taskId: task?.taskId,
        rawEventIds: row.rawEventIds,
        provenance: { rawIds: row.rawEventIds, layer: "devtools/dims.softNavigations" },
      };
    })
    .sort((a, b) => a.startTsUs - b.startTsUs);
}

function buildFramePipeline(trace: ParsedTrace) {
  const screenshotsByFrameSeq = new Map(
    buildScreenshots(trace)
      .filter((row) => row.frameSeqId)
      .map((row) => [row.frameSeqId, row.artifactId] as const),
  );
  return trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.name === "PipelineReporter" && isRecord((event.args as any)?.frame_reporter),
    )
    .map(({ event, index }) => {
      const frameReporter = (event.args as any).frame_reporter as Record<string, any>;
      const frameSequence = canonicalId(frameReporter.frame_sequence);
      const stageTimingsMs = Object.fromEntries(
        Object.entries(frameReporter)
          .filter(([key, value]) => typeof value === "number" && key !== "frame_sequence")
          .map(([key, value]) => [key, Number(value)]),
      );
      return {
        frameReportId: `frame-report:${index}`,
        eventId: `evt:${index}`,
        tsUs: event.ts,
        frameSequence,
        state: getNestedString(frameReporter.state) ?? "unknown",
        affectsSmoothness: Boolean(frameReporter.affects_smoothness),
        hasHighLatency: Boolean(frameReporter.has_high_latency),
        hasMainAnimation: Boolean(frameReporter.has_main_animation),
        scrollState: getNestedString(frameReporter.scroll_state),
        stageTimingsMs,
        screenshotArtifactId: frameSequence ? screenshotsByFrameSeq.get(frameSequence) : undefined,
        rawEventIds: [`evt:${index}`],
        provenance: { rawIds: [`evt:${index}`], layer: "devtools/views.framePipeline" },
      };
    });
}

function buildMainThreadTasks(trace: ParsedTrace) {
  const { threadNames } = buildThreadMetadata(trace.traceEvents);
  const rendererMainThreads = new Set(
    [...threadNames.entries()]
      .filter(
        ([, threadName]) => /renderer.?main/i.test(threadName) || threadName === "CrRendererMain",
      )
      .map(([threadKey]) => threadKey),
  );
  const facts = buildFacts(trace);
  const factsByThread = new Map<string, any[]>();
  for (const fact of facts) {
    if (!rendererMainThreads.has(fact.threadKey)) continue;
    if (!factsByThread.has(fact.threadKey)) factsByThread.set(fact.threadKey, []);
    factsByThread.get(fact.threadKey)!.push(fact);
  }
  for (const threadFacts of factsByThread.values()) {
    threadFacts.sort((a, b) => a.tsUs - b.tsUs || a.endUs - b.endUs);
  }

  const tasksByThread = new Map<
    string,
    Array<{ event: TraceEvent; index: number; start: number; end: number }>
  >();
  trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.ph === "X" && event.dur && event.dur > 0)
    .filter(({ event }) => rendererMainThreads.has(getThreadKey(event.pid, event.tid)))
    .filter(
      ({ event }) => event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask",
    )
    .forEach(({ event, index }) => {
      const threadKey = getThreadKey(event.pid, event.tid);
      if (!tasksByThread.has(threadKey)) tasksByThread.set(threadKey, []);
      tasksByThread.get(threadKey)!.push({
        event,
        index,
        start: event.ts,
        end: event.ts + (event.dur ?? 0),
      });
    });

  const rows: any[] = [];
  for (const [threadKey, tasks] of tasksByThread.entries()) {
    const threadFacts = factsByThread.get(threadKey) ?? [];
    tasks.sort((a, b) => a.start - b.start || a.end - b.end || a.index - b.index);
    let cursor = 0;
    for (const task of tasks) {
      while (cursor < threadFacts.length && threadFacts[cursor]!.tsUs < task.start) {
        cursor += 1;
      }
      const countByName = new Map<string, number>();
      const rawEventIds = [`evt:${task.index}`];
      let childEventCount = 0;
      for (let factIndex = cursor; factIndex < threadFacts.length; factIndex += 1) {
        const fact = threadFacts[factIndex]!;
        if (fact.tsUs > task.end) break;
        if (fact.eventId === `evt:${task.index}`) continue;
        if (fact.tsUs < task.start || fact.endUs > task.end) continue;
        childEventCount += 1;
        countByName.set(fact.name, (countByName.get(fact.name) ?? 0) + 1);
        rawEventIds.push(fact.eventId);
      }
      rows.push({
        taskId: `task:${task.index}`,
        eventId: `evt:${task.index}`,
        threadKey,
        tsUs: task.start,
        durationMs: (task.event.dur ?? 0) / 1000,
        childEventCount,
        functionCalls: countByName.get("FunctionCall") ?? 0,
        layouts: countByName.get("Layout") ?? 0,
        paints: countByName.get("Paint") ?? 0,
        renderMeasures: countByName.get("UserTiming::Measure") ?? 0,
        rawEventIds,
        provenance: { rawIds: rawEventIds, layer: "devtools/views.mainThreadTasks" },
      });
    }
  }

  return rows.sort((a, b) => b.durationMs - a.durationMs || a.tsUs - b.tsUs);
}

function buildCodeHotspots(trace: ParsedTrace) {
  const scripts = new Map(buildScripts(trace).map((row) => [row.scriptId, row] as const));
  const groups = new Map<string, any>();
  trace.traceEvents.forEach((event, index) => {
    if ((event.name !== "FunctionCall" && event.name !== "EvaluateScript") || event.ph !== "X")
      return;
    const data = isRecord(event.args?.data) ? (event.args!.data as Record<string, any>) : undefined;
    const url =
      getNestedString(data?.url) ?? getNestedString((event.args as any)?.url) ?? "(unknown)";
    const functionName = getNestedString(data?.functionName) ?? event.name;
    const scriptId = canonicalId(data?.scriptId);
    const key = `${scriptId ?? "?"}|${url}|${functionName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        hotspotId: `hotspot:${groups.size}`,
        scriptId,
        url,
        functionName,
        totalDurationMs: 0,
        maxDurationMs: 0,
        count: 0,
        sourceMapId: scriptId ? scripts.get(scriptId)?.sourceMapId : undefined,
        rawEventIds: [] as string[],
      });
    }
    const row = groups.get(key)!;
    const durationMs = (event.dur ?? 0) / 1000;
    row.totalDurationMs += durationMs;
    row.maxDurationMs = Math.max(row.maxDurationMs, durationMs);
    row.count += 1;
    row.rawEventIds.push(`evt:${index}`);
  });
  return [...groups.values()]
    .map((row) => ({
      ...row,
      provenance: { rawIds: row.rawEventIds, layer: "devtools/views.codeHotspots" },
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs || b.count - a.count);
}

function buildCpuProfileModel(trace: ParsedTrace) {
  const scripts = new Map(buildScripts(trace).map((row) => [row.scriptId, row] as const));
  const nodes = new Map<
    number,
    { nodeId: string; parentId?: string; callFrame: Record<string, any>; rawEventIds: string[] }
  >();
  const nodeChildren = new Map<number, Set<number>>();
  const samples: any[] = [];
  let sampleIndex = 0;

  const stackForNode = (nodeId: number) => {
    const path: number[] = [];
    const seen = new Set<number>();
    let current: number | undefined = nodeId;
    while (typeof current === "number" && !seen.has(current)) {
      seen.add(current);
      path.push(current);
      current = nodes.get(current)?.parentId ? Number(nodes.get(current)!.parentId) : undefined;
    }
    return path.reverse();
  };

  trace.traceEvents.forEach((event, index) => {
    if (event.name !== "ProfileChunk") return;
    const data = (event.args as any)?.data;
    const cpuProfile = isRecord(data?.cpuProfile)
      ? (data.cpuProfile as Record<string, any>)
      : undefined;
    const profileNodes = Array.isArray(cpuProfile?.nodes) ? cpuProfile.nodes : [];
    for (const node of profileNodes) {
      if (!isRecord(node) || typeof node.id !== "number") continue;
      const parentId = typeof node.parent === "number" ? String(node.parent) : undefined;
      const callFrame = isRecord(node.callFrame) ? (node.callFrame as Record<string, any>) : {};
      const rawEventId = `evt:${index}`;
      const existing = nodes.get(node.id);
      nodes.set(node.id, {
        nodeId: String(node.id),
        parentId,
        callFrame,
        rawEventIds: existing ? [...existing.rawEventIds, rawEventId] : [rawEventId],
      });
      if (typeof node.parent === "number") {
        if (!nodeChildren.has(node.parent)) nodeChildren.set(node.parent, new Set());
        nodeChildren.get(node.parent)!.add(node.id);
      }
    }

    const sampleIds = Array.isArray(cpuProfile?.samples) ? cpuProfile.samples : [];
    // timeDeltas lives under data (sibling of cpuProfile), NOT inside cpuProfile
    const timeDeltas = Array.isArray(data?.timeDeltas)
      ? data.timeDeltas
      : Array.isArray(cpuProfile?.timeDeltas)
        ? cpuProfile.timeDeltas
        : [];
    let cursorUs = event.ts;
    sampleIds.forEach((sampleNodeId, sampleOffset) => {
      if (typeof sampleNodeId !== "number") return;
      const timeDeltaUs =
        typeof timeDeltas[sampleOffset] === "number" ? timeDeltas[sampleOffset] : 0;
      cursorUs += timeDeltaUs;
      const stackNodeIds = stackForNode(sampleNodeId);
      const node = nodes.get(sampleNodeId);
      const callFrame = node?.callFrame ?? {};
      samples.push({
        sampleId: `cpu-sample:${sampleIndex++}`,
        eventId: `evt:${index}`,
        tsUs: cursorUs,
        timeDeltaUs,
        nodeId: String(sampleNodeId),
        parentNodeId: node?.parentId,
        functionName: getNestedString(callFrame.functionName) ?? "(anonymous)",
        url: getNestedString(callFrame.url),
        scriptId: canonicalId(callFrame.scriptId),
        lineNumber: typeof callFrame.lineNumber === "number" ? callFrame.lineNumber : undefined,
        columnNumber:
          typeof callFrame.columnNumber === "number" ? callFrame.columnNumber : undefined,
        codeType: getNestedString(callFrame.codeType),
        stackNodeIds: stackNodeIds.map((id) => String(id)),
        stackLabel: stackNodeIds
          .map((id) => getNestedString(nodes.get(id)?.callFrame.functionName) ?? "(anonymous)")
          .join(" > "),
        sourceMapId: canonicalId(callFrame.scriptId)
          ? scripts.get(canonicalId(callFrame.scriptId)!)?.sourceMapId
          : undefined,
        rawEventIds: [`evt:${index}`],
        provenance: { rawIds: [`evt:${index}`], layer: "devtools/facts.cpuSamples" },
      });
    });
  });

  const selfCounts = new Map<string, number>();
  const selfTimeUs = new Map<string, number>();
  samples.forEach((sample) => {
    selfCounts.set(sample.nodeId, (selfCounts.get(sample.nodeId) ?? 0) + 1);
    selfTimeUs.set(sample.nodeId, (selfTimeUs.get(sample.nodeId) ?? 0) + sample.timeDeltaUs);
  });

  const totalCountsMemo = new Map<string, number>();
  const totalTimeMemo = new Map<string, number>();
  const computeTotals = (nodeId: string): { count: number; timeUs: number } => {
    if (totalCountsMemo.has(nodeId)) {
      return { count: totalCountsMemo.get(nodeId)!, timeUs: totalTimeMemo.get(nodeId)! };
    }
    const children = nodeChildren.get(Number(nodeId)) ?? new Set<number>();
    let count = selfCounts.get(nodeId) ?? 0;
    let timeUs = selfTimeUs.get(nodeId) ?? 0;
    for (const childId of children) {
      const child = computeTotals(String(childId));
      count += child.count;
      timeUs += child.timeUs;
    }
    totalCountsMemo.set(nodeId, count);
    totalTimeMemo.set(nodeId, timeUs);
    return { count, timeUs };
  };

  const cpuNodes = [...nodes.values()]
    .map((node) => {
      const totals = computeTotals(node.nodeId);
      return {
        cpuNodeId: node.nodeId,
        nodeId: node.nodeId,
        parentNodeId: node.parentId,
        functionName: getNestedString(node.callFrame.functionName) ?? "(anonymous)",
        url: getNestedString(node.callFrame.url),
        scriptId: canonicalId(node.callFrame.scriptId),
        lineNumber:
          typeof node.callFrame.lineNumber === "number" ? node.callFrame.lineNumber : undefined,
        columnNumber:
          typeof node.callFrame.columnNumber === "number" ? node.callFrame.columnNumber : undefined,
        codeType: getNestedString(node.callFrame.codeType),
        selfSampleCount: selfCounts.get(node.nodeId) ?? 0,
        totalSampleCount: totals.count,
        selfTimeMs: (selfTimeUs.get(node.nodeId) ?? 0) / 1000,
        totalTimeMs: totals.timeUs / 1000,
        rawEventIds: node.rawEventIds,
        provenance: { rawIds: node.rawEventIds, layer: "devtools/dims.cpuNodes" },
      };
    })
    .sort((a, b) => b.totalSampleCount - a.totalSampleCount || a.nodeId.localeCompare(b.nodeId));

  const foldedStacks = new Map<string, any>();
  samples.forEach((sample) => {
    const key = sample.stackLabel || sample.functionName;
    if (!foldedStacks.has(key)) {
      foldedStacks.set(key, {
        stackId: `cpu-stack:${foldedStacks.size}`,
        stackLabel: key,
        sampleCount: 0,
        totalTimeMs: 0,
        topNodeId: sample.nodeId,
        rawEventIds: [] as string[],
      });
    }
    const row = foldedStacks.get(key)!;
    row.sampleCount += 1;
    row.totalTimeMs += sample.timeDeltaUs / 1000;
    row.rawEventIds.push(...sample.rawEventIds);
  });

  const bucketSizeUs = 5_000;
  const cpuTimelineBuckets = new Map<number, any>();
  samples.forEach((sample) => {
    const bucket = Math.floor(sample.tsUs / bucketSizeUs);
    if (!cpuTimelineBuckets.has(bucket)) {
      cpuTimelineBuckets.set(bucket, {
        bucketId: `cpu-bucket:${bucket}`,
        startTsUs: bucket * bucketSizeUs,
        endTsUs: bucket * bucketSizeUs + bucketSizeUs,
        sampleCount: 0,
        totalTimeMs: 0,
        topFunctions: new Map<string, number>(),
        rawEventIds: [] as string[],
      });
    }
    const row = cpuTimelineBuckets.get(bucket)!;
    row.sampleCount += 1;
    row.totalTimeMs += sample.timeDeltaUs / 1000;
    row.topFunctions.set(sample.functionName, (row.topFunctions.get(sample.functionName) ?? 0) + 1);
    row.rawEventIds.push(...sample.rawEventIds);
  });

  return {
    samples: samples.sort((a, b) => a.tsUs - b.tsUs || a.sampleId.localeCompare(b.sampleId)),
    cpuNodes,
    foldedStacks: [...foldedStacks.values()].sort(
      (a, b) => b.totalTimeMs - a.totalTimeMs || b.sampleCount - a.sampleCount,
    ),
    cpuTimeline: [...cpuTimelineBuckets.values()].map((bucket) => ({
      bucketId: bucket.bucketId,
      startTsUs: bucket.startTsUs,
      endTsUs: bucket.endTsUs,
      sampleCount: bucket.sampleCount,
      totalTimeMs: bucket.totalTimeMs,
      topFunctions: [...bucket.topFunctions.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([functionName, count]) => ({ functionName, count })),
      rawEventIds: bucket.rawEventIds,
      provenance: { rawIds: bucket.rawEventIds, layer: "devtools/views.cpuTimeline" },
    })),
  };
}

function buildCpuSampleFacts(trace: ParsedTrace) {
  return buildCpuProfileModel(trace).samples;
}

function buildCpuNodeRows(trace: ParsedTrace) {
  return buildCpuProfileModel(trace).cpuNodes;
}

function buildCpuCallTrees(trace: ParsedTrace) {
  return buildCpuProfileModel(trace).foldedStacks.map((row: any) => ({
    ...row,
    provenance: { rawIds: row.rawEventIds, layer: "devtools/views.cpuCallTrees" },
  }));
}

function buildCpuTimeline(trace: ParsedTrace) {
  return buildCpuProfileModel(trace).cpuTimeline;
}

function buildCpuHotspots(trace: ParsedTrace) {
  return buildCpuNodeRows(trace)
    .filter((row: any) => row.selfSampleCount > 0)
    .map((row: any) => ({
      cpuHotspotId: `cpu:${row.nodeId}`,
      nodeId: row.nodeId,
      functionName: row.functionName,
      url: row.url,
      scriptId: row.scriptId,
      lineNumber: row.lineNumber,
      columnNumber: row.columnNumber,
      codeType: row.codeType,
      sampleCount: row.selfSampleCount,
      totalSampleCount: row.totalSampleCount,
      selfTimeMs: row.selfTimeMs,
      totalTimeMs: row.totalTimeMs,
      rawEventIds: row.rawEventIds,
      provenance: { rawIds: row.rawEventIds, layer: "devtools/views.cpuHotspots" },
    }))
    .sort(
      (a, b) =>
        b.selfTimeMs - a.selfTimeMs ||
        b.sampleCount - a.sampleCount ||
        a.functionName.localeCompare(b.functionName),
    );
}

function aggregateCpuHotspotsForWindow(
  trace: ParsedTrace,
  startTsUs: number,
  endTsUs: number,
  scope: string,
  scopeId: string,
) {
  const groups = new Map<string, any>();
  buildCpuSampleFacts(trace)
    .filter((sample: any) => sample.tsUs >= startTsUs && sample.tsUs <= endTsUs)
    .forEach((sample: any) => {
      const key = `${sample.nodeId}|${sample.functionName}|${sample.url ?? ""}`;
      if (!groups.has(key)) {
        groups.set(key, {
          scopeId,
          nodeId: sample.nodeId,
          functionName: sample.functionName,
          url: sample.url,
          scriptId: sample.scriptId,
          sampleCount: 0,
          totalTimeMs: 0,
          rawEventIds: [] as string[],
        });
      }
      const row = groups.get(key)!;
      row.sampleCount += 1;
      row.totalTimeMs += sample.timeDeltaUs / 1000;
      row.rawEventIds.push(...sample.rawEventIds);
    });
  return [...groups.values()]
    .map((row) => ({
      ...row,
      [`${scope}CpuHotspotId`]: `${scope}-cpu:${scopeId}:${row.nodeId}`,
      provenance: { rawIds: row.rawEventIds, layer: `devtools/views.${scope}CpuHotspots` },
    }))
    .sort((a, b) => b.totalTimeMs - a.totalTimeMs || b.sampleCount - a.sampleCount);
}

function buildInteractionCpuHotspots(trace: ParsedTrace) {
  return buildInteractions(trace).flatMap((interaction) =>
    aggregateCpuHotspotsForWindow(
      trace,
      interaction.startTsUs,
      interaction.endTsUs,
      "interaction",
      interaction.interactionId,
    ),
  );
}

function buildTaskCpuHotspots(trace: ParsedTrace) {
  return buildMainThreadTasks(trace).flatMap((task) =>
    aggregateCpuHotspotsForWindow(
      trace,
      task.tsUs,
      task.tsUs + task.durationMs * 1000,
      "task",
      task.taskId,
    ),
  );
}

function buildInteractionWindows(trace: ParsedTrace) {
  const interactions = buildInteractions(trace);
  const renders = buildRenderMeasures(trace);
  const requests = buildRequests(trace);
  const screenshots = buildScreenshots(trace);
  const framePipeline = buildFramePipeline(trace);
  const layoutShifts = buildLayoutShifts(trace);
  const softNavigations = buildSoftNavigations(trace);
  return interactions.map((interaction) => ({
    interactionId: interaction.interactionId,
    type: interaction.type,
    durationMs: interaction.durationMs,
    renderCount: renders.filter(
      (row) => row.tsUs >= interaction.startTsUs && row.tsUs <= interaction.endTsUs,
    ).length,
    requestCount: requests.filter(
      (row) => row.startTimeUs >= interaction.startTsUs && row.startTimeUs <= interaction.endTsUs,
    ).length,
    screenshotCount: screenshots.filter(
      (row) => row.tsUs >= interaction.startTsUs && row.tsUs <= interaction.endTsUs,
    ).length,
    droppedFrameCount: framePipeline.filter(
      (row) =>
        row.tsUs >= interaction.startTsUs &&
        row.tsUs <= interaction.endTsUs &&
        row.state === "STATE_DROPPED",
    ).length,
    layoutShiftCount: layoutShifts.filter(
      (row) => row.tsUs >= interaction.startTsUs && row.tsUs <= interaction.endTsUs,
    ).length,
    softNavigationCount: softNavigations.filter(
      (row) => row.startTsUs <= interaction.endTsUs && row.endTsUs >= interaction.startTsUs,
    ).length,
    rawEventIds: interaction.rawEventIds,
    provenance: { rawIds: interaction.rawEventIds, layer: "devtools/views.interactionWindows" },
  }));
}

function buildVisualChanges(trace: ParsedTrace) {
  const rows: any[] = [];
  buildScreenshots(trace).forEach((row) => {
    rows.push({
      changeId: `visual:screenshot:${row.screenshotId}`,
      kind: "screenshot",
      tsUs: row.tsUs,
      artifactId: row.artifactId,
      rawEventIds: [row.eventId],
      provenance: { rawIds: [row.eventId], layer: "devtools/views.visualChanges" },
    });
  });
  buildLayoutShifts(trace).forEach((row) => {
    rows.push({
      changeId: row.layoutShiftId,
      kind: "layout-shift",
      tsUs: row.tsUs,
      score: row.score,
      rawEventIds: row.rawEventIds,
      provenance: { rawIds: row.rawEventIds, layer: "devtools/views.visualChanges" },
    });
  });
  trace.traceEvents.forEach((event, index) => {
    if (["Paint", "PrePaint", "AnimationFrame::Presentation"].includes(event.name)) {
      rows.push({
        changeId: `visual:${event.name}:${index}`,
        kind: event.name,
        tsUs: event.ts,
        rawEventIds: [`evt:${index}`],
        provenance: { rawIds: [`evt:${index}`], layer: "devtools/views.visualChanges" },
      });
    }
  });
  return rows.sort((a, b) => a.tsUs - b.tsUs);
}

function buildRenderComponentHotspots(trace: ParsedTrace) {
  const groups = new Map<string, any>();
  buildRenderMeasures(trace).forEach((row) => {
    const componentName = row.componentName ?? "(unknown)";
    if (!groups.has(componentName)) {
      groups.set(componentName, {
        componentName,
        renderCount: 0,
        totalDurationMs: 0,
        maxDurationMs: 0,
        track: row.track,
        rawEventIds: [] as string[],
      });
    }
    const group = groups.get(componentName)!;
    group.renderCount += 1;
    group.totalDurationMs += row.durationMs;
    group.maxDurationMs = Math.max(group.maxDurationMs, row.durationMs);
    group.rawEventIds.push(row.eventId);
  });
  return [...groups.values()]
    .map((row) => ({
      ...row,
      avgDurationMs: row.renderCount > 0 ? row.totalDurationMs / row.renderCount : 0,
      provenance: { rawIds: row.rawEventIds, layer: "devtools/views.renderComponentHotspots" },
    }))
    .sort((a, b) => b.totalDurationMs - a.totalDurationMs || b.renderCount - a.renderCount);
}

function buildInteractionRenders(trace: ParsedTrace) {
  const renders = buildRenderMeasures(trace);
  return buildInteractions(trace)
    .flatMap((interaction) => {
      const groups = new Map<string, any>();
      renders
        .filter((row) => row.tsUs >= interaction.startTsUs && row.tsUs <= interaction.endTsUs)
        .forEach((row) => {
          const componentName = row.componentName ?? "(unknown)";
          if (!groups.has(componentName)) {
            groups.set(componentName, {
              interactionId: interaction.interactionId,
              componentName,
              renderCount: 0,
              totalDurationMs: 0,
              rawEventIds: [] as string[],
            });
          }
          const group = groups.get(componentName)!;
          group.renderCount += 1;
          group.totalDurationMs += row.durationMs;
          group.rawEventIds.push(row.eventId);
        });
      return [...groups.values()].map((row) => ({
        ...row,
        provenance: { rawIds: row.rawEventIds, layer: "devtools/views.interactionRenders" },
      }));
    })
    .sort(
      (a, b) =>
        b.totalDurationMs - a.totalDurationMs || a.interactionId.localeCompare(b.interactionId),
    );
}

function buildNetworkWaterfall(trace: ParsedTrace) {
  const { minTs } = getTraceBounds(trace.traceEvents);
  return buildRequests(trace).map((row, index) => ({
    requestWaterfallId: `request-waterfall:${index}`,
    requestId: row.requestId,
    url: row.url,
    method: row.method,
    startOffsetMs: (row.startTimeUs - minTs) / 1000,
    endOffsetMs: row.endTimeUs ? (row.endTimeUs - minTs) / 1000 : undefined,
    durationMs: row.durationMs,
    statusCode: row.statusCode,
    protocol: row.protocol,
    rawEventIds: row.rawEventIds,
    provenance: { rawIds: row.rawEventIds, layer: "devtools/views.networkWaterfall" },
  }));
}

function buildLayoutShiftClusters(trace: ParsedTrace) {
  const shifts = buildLayoutShifts(trace).sort((a, b) => a.tsUs - b.tsUs);
  const clusters: any[] = [];
  let current: any = null;
  for (const shift of shifts) {
    if (
      !current ||
      shift.tsUs - current.lastTsUs > 1_000_000 ||
      shift.tsUs - current.startTsUs > 5_000_000
    ) {
      current = {
        layoutShiftClusterId: `layout-shift-cluster:${clusters.length}`,
        startTsUs: shift.tsUs,
        lastTsUs: shift.tsUs,
        totalScore: 0,
        shiftCount: 0,
        impactedNodeCount: 0,
        rawEventIds: [] as string[],
      };
      clusters.push(current);
    }
    current.lastTsUs = shift.tsUs;
    current.totalScore += shift.score;
    current.shiftCount += 1;
    current.impactedNodeCount += shift.impactedNodeCount;
    current.rawEventIds.push(...shift.rawEventIds);
  }
  return clusters
    .map((cluster) => ({
      ...cluster,
      durationMs: (cluster.lastTsUs - cluster.startTsUs) / 1000,
      provenance: { rawIds: cluster.rawEventIds, layer: "devtools/views.layoutShiftClusters" },
    }))
    .sort((a, b) => b.totalScore - a.totalScore || a.startTsUs - b.startTsUs);
}

function buildRequestBodies(trace: ParsedTrace) {
  const requests = new Map(buildRequests(trace).map((row) => [row.requestId, row] as const));
  const rows: any[] = [];
  trace.traceEvents.forEach((event, index) => {
    const data = isRecord(event.args?.data) ? (event.args!.data as Record<string, any>) : undefined;
    const requestId = getNestedString(data?.requestId);
    if (!requestId || !data) return;
    const blobs = findEmbeddedBlobs(data).filter((blob) => blob.path !== "$");
    blobs.forEach((blob, blobIndex) => {
      const request = requests.get(requestId);
      rows.push({
        requestBodyId: `request-body:${index}:${blobIndex}`,
        artifactId: `artifact:devtools:request-body:${index}:${blobIndex}`,
        requestId,
        url: request?.url,
        tsUs: event.ts,
        mediaType:
          blob.mediaType === "application/octet-stream"
            ? (request?.mimeType ?? blob.mediaType)
            : blob.mediaType,
        sizeBytes: blob.bytes.byteLength,
        path: blob.path,
        decodedKind: blob.decodedKind,
        confidence: blob.confidence,
        bytes: blob.bytes,
        filename: `${requestId}-${String(blobIndex).padStart(2, "0")}`,
        rawEventIds: [`evt:${index}`],
        provenance: { rawIds: [`evt:${index}`], layer: "devtools/dims.requestBodies" },
      });
    });
  });
  return rows;
}

function buildSummary(trace: ParsedTrace) {
  const facts = buildFacts(trace);
  const indexes = buildIndexes(trace.traceEvents);
  const { minTs, maxTs } = getTraceBounds(trace.traceEvents);
  return {
    totalEvents: trace.traceEvents.length,
    durationMs: (maxTs - minTs) / 1000,
    categories: indexes.byCategory.size,
    threads: indexes.byThread.size,
    processes: buildProcessRows(trace).length,
    screenshots: getScreenshotEvents(trace).length,
    networkRequests: buildRequests(trace).length,
    networkBodies: buildRequestBodies(trace).length,
    interactions: buildInteractions(trace).length,
    scripts: buildScripts(trace).length,
    sourceMaps: buildSourceMaps(trace).length,
    sources: buildSources(trace).length,
    frames: buildFrameRows(trace).length,
    workers: buildWorkerRows(trace).length,
    layoutShifts: buildLayoutShifts(trace).length,
    layoutShiftClusters: buildLayoutShiftClusters(trace).length,
    softNavigations: buildSoftNavigations(trace).length,
    frameReports: buildFramePipeline(trace).length,
    codeHotspots: buildCodeHotspots(trace).length,
    cpuHotspots: buildCpuHotspots(trace).length,
    cpuSamples: buildCpuSampleFacts(trace).length,
    facts: facts.length,
  };
}

function buildHotspotsReport(trace: ParsedTrace) {
  return {
    codeHotspots: buildCodeHotspots(trace).slice(0, 50),
    cpuHotspots: buildCpuHotspots(trace).slice(0, 50),
    cpuCallTrees: buildCpuCallTrees(trace).slice(0, 20),
  };
}

function buildScriptReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const scripts = buildScripts(trace);
  const scriptId = typeof args?.scriptId === "string" ? args.scriptId : undefined;
  const url = typeof args?.url === "string" ? args.url : undefined;
  const script = scriptId
    ? scripts.find((row) => row.scriptId === scriptId)
    : url
      ? scripts.find((row) => row.url === url)
      : scripts[0];
  if (!script) {
    return { script: null, sourceMap: null, sources: [], codeHotspots: [], cpuHotspots: [] };
  }
  const codeHotspots = buildCodeHotspots(trace).filter(
    (row) => row.scriptId === script.scriptId || (!!script.url && row.url === script.url),
  );
  const cpuHotspots = buildCpuHotspots(trace).filter(
    (row) => row.scriptId === script.scriptId || (!!script.url && row.url === script.url),
  );
  const sourceMap = script.sourceMapId
    ? (buildSourceMaps(trace).find((row) => row.sourceMapId === script.sourceMapId) ?? null)
    : null;
  const sources = sourceMap
    ? buildSources(trace).filter((row) => row.sourceMapId === sourceMap.sourceMapId)
    : [];
  return {
    script,
    sourceMap,
    sources,
    codeHotspots,
    cpuHotspots,
  };
}

function buildFrameReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const frameSequence = typeof args?.frameSequence === "string" ? args.frameSequence : undefined;
  const frame = frameSequence
    ? buildFramePipeline(trace).find((row) => row.frameSequence === frameSequence)
    : buildFramePipeline(trace)[0];
  if (!frame) {
    return { frame: null, screenshot: null, visualChanges: [] };
  }
  const screenshot = frame.screenshotArtifactId
    ? (buildScreenshots(trace).find((row) => row.artifactId === frame.screenshotArtifactId) ?? null)
    : null;
  const visualChanges = buildVisualChanges(trace).filter(
    (row) => row.tsUs >= frame.tsUs - 16_000 && row.tsUs <= frame.tsUs + 16_000,
  );
  return { frame, screenshot, visualChanges };
}

function buildRequestReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const requestId = typeof args?.requestId === "string" ? args.requestId : undefined;
  const url = typeof args?.url === "string" ? args.url : undefined;
  const request = requestId
    ? buildRequests(trace).find((row) => row.requestId === requestId)
    : url
      ? buildRequests(trace).find((row) => row.url === url)
      : buildRequests(trace)[0];
  if (!request) {
    return { request: null };
  }
  const visualChanges = buildVisualChanges(trace).filter(
    (row) =>
      row.tsUs >= request.startTimeUs && row.tsUs <= (request.endTimeUs ?? request.startTimeUs),
  );
  return { request, visualChanges };
}

function buildSoftNavigationReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const softNavigationId =
    typeof args?.softNavigationId === "string" ? args.softNavigationId : undefined;
  const softNavigation = softNavigationId
    ? buildSoftNavigations(trace).find((row) => row.softNavigationId === softNavigationId)
    : buildSoftNavigations(trace)[0];
  if (!softNavigation) {
    return { softNavigation: null, layoutShifts: [], screenshots: [], requests: [] };
  }
  return {
    softNavigation,
    layoutShifts: buildLayoutShifts(trace).filter(
      (row) => row.tsUs >= softNavigation.startTsUs && row.tsUs <= softNavigation.endTsUs,
    ),
    screenshots: buildScreenshots(trace).filter(
      (row) => row.tsUs >= softNavigation.startTsUs && row.tsUs <= softNavigation.endTsUs,
    ),
    requests: buildRequests(trace).filter(
      (row) =>
        row.startTimeUs >= softNavigation.startTsUs && row.startTimeUs <= softNavigation.endTsUs,
    ),
  };
}

function buildInteractionReport(trace: ParsedTrace, interactionId?: string) {
  const interactions = buildInteractions(trace);
  const target = interactionId
    ? interactions.find((row) => row.interactionId === interactionId)
    : interactions[0];
  if (!target) {
    return {
      interaction: null,
      renders: [],
      topComponents: [],
      eventDispatches: [],
      droppedFrames: 0,
      requests: [],
      layoutShifts: [],
      softNavigations: [],
      screenshots: [],
      codeHotspots: [],
      cpuHotspots: [],
    };
  }
  const renderMeasures = buildRenderMeasures(trace).filter(
    (row) => row.tsUs >= target.startTsUs && row.tsUs <= target.endTsUs,
  );
  const componentCounts = new Map<string, number>();
  for (const row of renderMeasures) {
    if (!row.componentName) continue;
    componentCounts.set(row.componentName, (componentCounts.get(row.componentName) ?? 0) + 1);
  }
  const eventDispatches = trace.traceEvents
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        event.name === "EventDispatch" &&
        event.ts >= target.startTsUs - 5_000 &&
        event.ts <= target.endTsUs + 5_000,
    )
    .map(({ event, index }) => ({
      eventId: `evt:${index}`,
      type: getNestedString(event.args?.data?.type) ?? "unknown",
      tsUs: event.ts,
      durMs: (event.dur ?? 0) / 1000,
    }));
  const framePipeline = buildFramePipeline(trace).filter(
    (row) => row.tsUs >= target.startTsUs && row.tsUs <= target.endTsUs,
  );
  const requests = buildRequests(trace).filter(
    (row) => row.startTimeUs >= target.startTsUs && row.startTimeUs <= target.endTsUs,
  );
  const layoutShifts = buildLayoutShifts(trace).filter(
    (row) => row.tsUs >= target.startTsUs && row.tsUs <= target.endTsUs,
  );
  const softNavigations = buildSoftNavigations(trace).filter(
    (row) => row.startTsUs <= target.endTsUs && row.endTsUs >= target.startTsUs,
  );
  const screenshots = buildScreenshots(trace).filter(
    (row) => row.tsUs >= target.startTsUs && row.tsUs <= target.endTsUs,
  );
  const codeHotspots = buildCodeHotspots(trace)
    .filter((row) =>
      row.rawEventIds.some((eventId: string) => {
        const rawIndex = Number(String(eventId).replace("evt:", ""));
        const event = trace.traceEvents[rawIndex];
        return event && event.ts >= target.startTsUs && event.ts <= target.endTsUs;
      }),
    )
    .slice(0, 20);
  const cpuHotspots = buildInteractionCpuHotspots(trace)
    .filter((row) => row.scopeId === target.interactionId)
    .slice(0, 20);
  const droppedFrames = framePipeline.filter((row) => row.state === "STATE_DROPPED").length;
  return {
    interaction: {
      ...target,
      provenance: { rawIds: target.rawEventIds, layer: "devtools.interaction" },
    },
    renders: renderMeasures,
    topComponents: [...componentCounts.entries()]
      .map(([componentName, count]) => ({ componentName, count }))
      .sort((a, b) => b.count - a.count || a.componentName.localeCompare(b.componentName))
      .slice(0, 20),
    eventDispatches,
    droppedFrames,
    requests,
    layoutShifts,
    softNavigations,
    screenshots,
    framePipeline,
    codeHotspots,
    cpuHotspots,
  };
}

function prettySummaryReport(trace: ParsedTrace) {
  return prettyValue(buildSummary(trace));
}

function prettyInteractionReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const report = buildInteractionReport(trace, typeof args?.id === "string" ? args.id : undefined);
  if (!report.interaction) return "No interaction found.";
  const parts = [
    `interaction ${report.interaction.interactionId} ${report.interaction.type} ${report.interaction.durationMs.toFixed(1)}ms`,
    `renders ${report.renders.length}`,
    `droppedFrames ${report.droppedFrames}`,
    `requests ${report.requests.length}`,
    `layoutShifts ${report.layoutShifts.length}`,
    `softNavigations ${report.softNavigations.length}`,
  ];
  if (report.topComponents.length > 0) {
    parts.push("", "top components", tableValue(report.topComponents.slice(0, 10)));
  }
  if (report.cpuHotspots.length > 0) {
    parts.push(
      "",
      "cpu hotspots",
      tableValue(
        report.cpuHotspots
          .slice(0, 10)
          .map((row: any) => ({
            functionName: row.functionName,
            totalTimeMs: row.totalTimeMs,
            sampleCount: row.sampleCount,
          })),
      ),
    );
  }
  return parts.join("\n");
}

function prettyFrameReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const report = buildFrameReport(trace, args);
  if (!report.frame) return "No frame report found.";
  return prettyValue({
    frameSequence: report.frame.frameSequence,
    state: report.frame.state,
    screenshotArtifactId: report.frame.screenshotArtifactId,
    visualChanges: (report.visualChanges ?? []).slice(0, 20),
  });
}

function prettyRequestReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const report = buildRequestReport(trace, args);
  if (!report.request) return "No request found.";
  return prettyValue({
    request: report.request,
    visualChanges: (report.visualChanges ?? []).slice(0, 20),
  });
}

function prettySoftNavigationReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const report = buildSoftNavigationReport(trace, args);
  if (!report.softNavigation) return "No soft navigation found.";
  return prettyValue({
    softNavigation: report.softNavigation,
    layoutShifts: report.layoutShifts,
    requests: report.requests,
    screenshots: report.screenshots,
  });
}

function prettyHotspotsReport(trace: ParsedTrace) {
  const report = buildHotspotsReport(trace);
  return [
    "code hotspots",
    tableValue(
      report.codeHotspots
        .slice(0, 10)
        .map((row: any) => ({
          functionName: row.functionName,
          totalDurationMs: row.totalDurationMs,
          count: row.count,
        })),
    ),
    "",
    "cpu hotspots",
    tableValue(
      report.cpuHotspots
        .slice(0, 10)
        .map((row: any) => ({
          functionName: row.functionName,
          selfTimeMs: row.selfTimeMs,
          totalTimeMs: row.totalTimeMs,
          sampleCount: row.sampleCount,
        })),
    ),
  ].join("\n");
}

function prettyScriptReport(trace: ParsedTrace, args?: Record<string, unknown>) {
  const report = buildScriptReport(trace, args);
  if (!report.script) return "No script found.";
  return prettyValue({
    script: report.script,
    sourceMap: report.sourceMap,
    sources: report.sources.slice(0, 20),
    codeHotspots: report.codeHotspots.slice(0, 20),
    cpuHotspots: report.cpuHotspots.slice(0, 20),
  });
}

class DevtoolsArtifactProvider implements ArtifactProvider {
  id = "devtools-artifacts";
  constructor(private readonly trace: ParsedTrace) {}

  async list(_session: DatasetSession) {
    const screenshots = buildScreenshots(this.trace).map<ArtifactRef>((row) => ({
      id: row.artifactId,
      kind: "image",
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      filenameHint: row.filename,
      metadata: { screenshotId: row.screenshotId },
    }));
    const scripts = buildScripts(this.trace)
      .filter((row) => row.sourceTextArtifactId)
      .map<ArtifactRef>((row) => ({
        id: row.sourceTextArtifactId,
        kind: "text",
        mediaType: "text/javascript",
        sizeBytes: row.sourceTextBytes,
        filenameHint: `${row.scriptId}-${basename(row.url ?? `script-${row.scriptId}`)}`,
        metadata: { scriptId: row.scriptId, url: row.url },
      }));
    const sourceMaps = buildSourceMaps(this.trace).map<ArtifactRef>((row) => ({
      id: row.artifactId,
      kind: "json",
      mediaType: "application/source-map+json",
      filenameHint: `${row.sourceMapId}.json`,
      metadata: { url: row.url, sourceMapUrl: row.sourceMapUrl },
    }));
    const sources = buildSources(this.trace)
      .filter((row) => row.artifactId)
      .map<ArtifactRef>((row) => ({
        id: row.artifactId,
        kind: "text",
        mediaType: "text/plain",
        sizeBytes: row.sizeBytes,
        filenameHint: row.sourcePath,
        metadata: { sourcePath: row.sourcePath },
      }));
    const requestBodies = buildRequestBodies(this.trace).map<ArtifactRef>((row) => ({
      id: row.artifactId,
      kind: row.decodedKind === "binary" ? "binary" : row.decodedKind === "json" ? "json" : "text",
      mediaType: row.mediaType,
      sizeBytes: row.sizeBytes,
      filenameHint: row.filename,
      metadata: {
        requestId: row.requestId,
        url: row.url,
        path: row.path,
        confidence: row.confidence,
      },
    }));
    return [...screenshots, ...scripts, ...sourceMaps, ...sources, ...requestBodies];
  }

  canHandle(artifactId: string) {
    return artifactId.startsWith("artifact:devtools:") || artifactId.startsWith("artifact:code:");
  }

  async get(_session: DatasetSession, artifactId: string) {
    const items = await this.list(_session);
    return items.find((item) => item.id === artifactId) ?? null;
  }

  async read(_session: DatasetSession, artifactId: string): Promise<ArtifactData | null> {
    if (artifactId.startsWith("artifact:devtools:screenshot:")) {
      const id = Number(artifactId.split(":").pop());
      const row = buildScreenshots(this.trace).find((item) => item.index === id);
      if (!row) return null;
      return {
        kind: "image",
        mediaType: row.mediaType,
        bytes: Buffer.from(row.base64, "base64"),
      };
    }
    if (artifactId.startsWith("artifact:devtools:script:")) {
      const scriptId = artifactId.split(":").pop();
      const match = this.trace.traceEvents.find(
        (event) =>
          canonicalId(event.args?.data?.scriptId) === scriptId &&
          typeof event.args?.data?.sourceText === "string",
      );
      if (!match) return null;
      return {
        kind: "text",
        mediaType: "text/javascript",
        text: String(match.args!.data.sourceText),
      };
    }
    if (artifactId.startsWith("artifact:code:sourcemap:")) {
      const index = Number(artifactId.split(":").pop());
      const sourceMaps = Array.isArray(this.trace.metadata.sourceMaps)
        ? (this.trace.metadata.sourceMaps as SourceMapEntry[])
        : [];
      const entry = sourceMaps[index];
      if (!entry) return null;
      return {
        kind: "json",
        mediaType: "application/source-map+json",
        json: entry,
      };
    }
    if (artifactId.startsWith("artifact:code:source:")) {
      const [, , , mapIndexText, sourceIndexText] = artifactId.split(":");
      const mapIndex = Number(mapIndexText);
      const sourceIndex = Number(sourceIndexText);
      const sourceMaps = Array.isArray(this.trace.metadata.sourceMaps)
        ? (this.trace.metadata.sourceMaps as SourceMapEntry[])
        : [];
      const entry = sourceMaps[mapIndex];
      const content = entry?.sourceMap?.sourcesContent?.[sourceIndex];
      if (typeof content !== "string") return null;
      return {
        kind: "text",
        mediaType: "text/plain",
        text: content,
      };
    }
    if (artifactId.startsWith("artifact:devtools:request-body:")) {
      const row = buildRequestBodies(this.trace).find((item) => item.artifactId === artifactId);
      if (!row) return null;
      if (row.decodedKind === "json") {
        return {
          kind: "json",
          mediaType: row.mediaType,
          json: JSON.parse(Buffer.from(row.bytes).toString("utf8")),
        };
      }
      if (row.decodedKind === "text") {
        return {
          kind: "text",
          mediaType: row.mediaType,
          text: Buffer.from(row.bytes).toString("utf8"),
        };
      }
      return {
        kind: "binary",
        mediaType: row.mediaType,
        bytes: row.bytes,
      };
    }
    return null;
  }
}

const screenshotCollection: FileCollectionProvider = {
  id: "devtools.screenshots",
  description: "Export screenshots from the trace",
  async listItems(session) {
    const rows = await session.getTable("devtools.dims.screenshots")!.rows(session);
    return (rows as any[]).map((row) => ({
      relativePath: `screenshots/${row.filename}`,
      artifactId: row.artifactId,
      metadata: { screenshotId: row.screenshotId, tsUs: row.tsUs },
    }));
  },
};

const scriptsCollection: FileCollectionProvider = {
  id: "devtools.scripts",
  description: "Export inline script sources from the trace",
  async listItems(session) {
    const rows = await session.getTable("devtools.dims.scripts")!.rows(session);
    return (rows as any[])
      .filter((row) => row.sourceTextArtifactId)
      .map((row) => ({
        relativePath: `scripts/${row.scriptId}-${basename(row.url ?? `script-${row.scriptId}.js`)}`,
        artifactId: row.sourceTextArtifactId,
        metadata: { scriptId: row.scriptId, url: row.url },
      }));
  },
};

const sourceMapsCollection: FileCollectionProvider = {
  id: "code.source-maps",
  description: "Export sourcemaps embedded in the dataset",
  async listItems(session) {
    const rows = await session.getTable("code.dims.sourceMaps")!.rows(session);
    return (rows as any[]).map((row) => ({
      relativePath: `source-maps/${row.sourceMapId}.json`,
      artifactId: row.artifactId,
      metadata: { url: row.url },
    }));
  },
};

const sourcesCollection: FileCollectionProvider = {
  id: "code.sources",
  description: "Export original sources embedded in sourcemaps",
  async listItems(session) {
    const rows = await session.getTable("code.dims.sources")!.rows(session);
    return (rows as any[])
      .filter((row) => row.artifactId)
      .map((row) => ({
        relativePath: `sources/${String(row.sourcePath).replace(/^[./]+/, "")}`,
        artifactId: row.artifactId,
        metadata: { sourceMapId: row.sourceMapId },
      }));
  },
};

const requestBodiesCollection: FileCollectionProvider = {
  id: "devtools.network-bodies",
  description: "Export request/response bodies embedded in the trace",
  async listItems(session) {
    const rows = await session.getTable("devtools.dims.requestBodies")!.rows(session);
    return (rows as any[]).map((row) => ({
      relativePath: `network-bodies/${sanitizeFilename(row.requestId)}-${sanitizeFilename(row.filename)}.${row.mediaType.includes("json") ? "json" : row.mediaType.startsWith("text/") ? "txt" : "bin"}`,
      artifactId: row.artifactId,
      metadata: { requestId: row.requestId, url: row.url, mediaType: row.mediaType },
    }));
  },
};

function buildCapabilityMap(trace: ParsedTrace): CapabilityMap {
  const events = trace.traceEvents;
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps) ? trace.metadata.sourceMaps : [];
  const sources = buildSources(trace);
  const scripts = buildScripts(trace);
  return {
    screenshots: getScreenshotEvents(trace).length > 0,
    cpuProfile: events.some((event) => event.name === "ProfileChunk"),
    eventTiming: events.some((event) => event.name === "EventTiming"),
    framePipeline: events.some((event) => event.name === "PipelineReporter"),
    networkTiming: events.some((event) => event.name === "ResourceSendRequest"),
    networkBodies: buildRequestBodies(trace).length > 0,
    inlineScriptSource: scripts.some((row) => row.hasSourceText),
    sourceMaps: sourceMaps.length > 0,
    sourceContents: sources.some((row) => row.hasContent),
    renderUserTiming: events.some((event) =>
      splitCategories(event.cat).includes("blink.user_timing"),
    ),
    layoutShift: events.some((event) => event.name === "LayoutShift"),
    softNavigation: events.some((event) => event.name === "SoftNavigation"),
  };
}

function createTable(
  name: string,
  description: string,
  columns: any[],
  getRows: (trace: ParsedTrace) => unknown[],
): TableProvider {
  return {
    name,
    description,
    columns,
    async rows(session, options) {
      const trace = (await session.layers.get<ParsedTrace>("devtools/trace")) as ParsedTrace;
      const rows = getRows(trace);
      const limit = options?.limit && options.limit > 0 ? options.limit : undefined;
      return limit ? rows.slice(0, limit) : rows;
    },
  };
}

function createReport(
  name: string,
  description: string,
  run: (trace: ParsedTrace, args?: Record<string, unknown>) => unknown,
  pretty?: (trace: ParsedTrace, args?: Record<string, unknown>) => string,
): ReportProvider {
  return {
    name,
    description,
    async run(session, args) {
      const trace = (await session.layers.get<ParsedTrace>("devtools/trace")) as ParsedTrace;
      return run(trace, args);
    },
    async pretty(session, args) {
      const trace = (await session.layers.get<ParsedTrace>("devtools/trace")) as ParsedTrace;
      return pretty ? pretty(trace, args) : prettyValue(run(trace, args));
    },
  };
}

function hashFilePath(filePath: string) {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 8);
}

export class DevtoolsDriver implements SourceDriver {
  id = "devtools";

  async detect(source: SourceProbe): Promise<SourceDetection | null> {
    if (source.isDirectory) return null;
    if (!source.path.endsWith(".json") && !source.path.endsWith(".json.gz")) return null;
    try {
      const parsed = JSON.parse(await readMaybeGzipText(source.path));
      return isRecord(parsed) && Array.isArray(parsed.traceEvents)
        ? { kind: "devtools", driverId: this.id }
        : null;
    } catch {
      return null;
    }
  }

  async open(sourcePath: string, detection: SourceDetection) {
    const trace = await parseTraceFile(sourcePath);
    const session = new DatasetSession({
      sourcePath,
      detection,
      itemCount: trace.traceEvents.length,
      rawDocument: async () => ({ metadata: trace.metadata, traceEvents: trace.traceEvents }),
      capabilities: async () => buildCapabilityMap(trace),
    });

    session.layers.register({ key: "devtools/trace", evictable: false, build: async () => trace });
    session.layers.register({
      key: "devtools/facts.events",
      deps: ["devtools/trace"],
      build: async () => buildFacts(trace),
    });
    session.layers.register({
      key: "devtools/facts.instantEvents",
      deps: ["devtools/trace"],
      build: async () => buildInstantFacts(trace),
    });
    session.layers.register({
      key: "devtools/facts.sliceEvents",
      deps: ["devtools/trace"],
      build: async () => buildSliceFacts(trace),
    });
    session.layers.register({
      key: "devtools/facts.asyncFlows",
      deps: ["devtools/trace"],
      build: async () => buildAsyncFlowFacts(trace),
    });
    session.layers.register({
      key: "devtools/facts.objectLifecycles",
      deps: ["devtools/trace"],
      build: async () => buildObjectLifecycles(trace),
    });
    session.layers.register({
      key: "devtools/facts.cpuSamples",
      deps: ["devtools/trace"],
      weight: "heavy",
      build: async () => buildCpuSampleFacts(trace),
    });
    session.layers.register({
      key: "devtools/indexes.basic",
      deps: ["devtools/trace"],
      build: async () => buildIndexes(trace.traceEvents),
    });
    session.layers.register({
      key: "devtools/indexes.secondary",
      deps: ["devtools/trace"],
      build: async () => buildSecondaryIndexes(trace),
    });
    session.layers.register({
      key: "devtools/dims.processes",
      deps: ["devtools/trace"],
      build: async () => buildProcessRows(trace),
    });
    session.layers.register({
      key: "devtools/dims.threads",
      deps: ["devtools/trace"],
      build: async () => buildThreadRows(trace),
    });
    session.layers.register({
      key: "devtools/dims.frames",
      deps: ["devtools/trace"],
      build: async () => buildFrameRows(trace),
    });
    session.layers.register({
      key: "devtools/dims.workers",
      deps: ["devtools/trace"],
      build: async () => buildWorkerRows(trace),
    });
    session.layers.register({
      key: "devtools/dims.layers",
      deps: ["devtools/trace"],
      build: async () => buildLayerRows(trace),
    });
    session.layers.register({
      key: "devtools/dims.requests",
      deps: ["devtools/trace"],
      build: async () => buildRequests(trace),
    });
    session.layers.register({
      key: "devtools/dims.requestBodies",
      deps: ["devtools/trace"],
      build: async () => buildRequestBodies(trace),
    });
    session.layers.register({
      key: "devtools/dims.screenshots",
      deps: ["devtools/trace"],
      build: async () => buildScreenshots(trace),
    });
    session.layers.register({
      key: "devtools/dims.interactions",
      deps: ["devtools/trace"],
      build: async () => buildInteractions(trace),
    });
    session.layers.register({
      key: "devtools/dims.tasks",
      deps: ["devtools/trace", "devtools/facts.events"],
      build: async () => buildMainThreadTasks(trace),
    });
    session.layers.register({
      key: "devtools/dims.scripts",
      deps: ["devtools/trace"],
      build: async () => buildScripts(trace),
    });
    session.layers.register({
      key: "devtools/dims.layoutShifts",
      deps: ["devtools/trace"],
      build: async () => buildLayoutShifts(trace),
    });
    session.layers.register({
      key: "devtools/dims.softNavigations",
      deps: ["devtools/trace", "devtools/dims.tasks"],
      build: async () => buildSoftNavigations(trace),
    });
    session.layers.register({
      key: "devtools/dims.cpuNodes",
      deps: ["devtools/trace"],
      weight: "heavy",
      build: async () => buildCpuNodeRows(trace),
    });
    session.layers.register({
      key: "devtools/views.renderMeasures",
      deps: ["devtools/trace"],
      build: async () => buildRenderMeasures(trace),
    });
    session.layers.register({
      key: "devtools/views.renderComponentHotspots",
      deps: ["devtools/trace"],
      build: async () => buildRenderComponentHotspots(trace),
    });
    session.layers.register({
      key: "devtools/views.interactionRenders",
      deps: ["devtools/trace"],
      build: async () => buildInteractionRenders(trace),
    });
    session.layers.register({
      key: "devtools/views.framePipeline",
      deps: ["devtools/trace"],
      build: async () => buildFramePipeline(trace),
    });
    session.layers.register({
      key: "devtools/views.mainThreadTasks",
      deps: ["devtools/dims.tasks"],
      build: async () => buildMainThreadTasks(trace),
    });
    session.layers.register({
      key: "devtools/views.codeHotspots",
      deps: ["devtools/trace"],
      build: async () => buildCodeHotspots(trace),
    });
    session.layers.register({
      key: "devtools/views.cpuHotspots",
      deps: ["devtools/dims.cpuNodes", "devtools/facts.cpuSamples"],
      weight: "heavy",
      build: async () => buildCpuHotspots(trace),
    });
    session.layers.register({
      key: "devtools/views.cpuCallTrees",
      deps: ["devtools/facts.cpuSamples"],
      weight: "heavy",
      build: async () => buildCpuCallTrees(trace),
    });
    session.layers.register({
      key: "devtools/views.cpuTimeline",
      deps: ["devtools/facts.cpuSamples"],
      weight: "heavy",
      build: async () => buildCpuTimeline(trace),
    });
    session.layers.register({
      key: "devtools/views.interactionCpuHotspots",
      deps: ["devtools/facts.cpuSamples", "devtools/dims.interactions"],
      weight: "heavy",
      build: async () => buildInteractionCpuHotspots(trace),
    });
    session.layers.register({
      key: "devtools/views.taskCpuHotspots",
      deps: ["devtools/facts.cpuSamples", "devtools/dims.tasks"],
      weight: "heavy",
      build: async () => buildTaskCpuHotspots(trace),
    });
    session.layers.register({
      key: "devtools/views.networkWaterfall",
      deps: ["devtools/dims.requests"],
      build: async () => buildNetworkWaterfall(trace),
    });
    session.layers.register({
      key: "devtools/views.layoutShiftClusters",
      deps: ["devtools/dims.layoutShifts"],
      build: async () => buildLayoutShiftClusters(trace),
    });
    session.layers.register({
      key: "devtools/views.interactionWindows",
      deps: ["devtools/trace"],
      build: async () => buildInteractionWindows(trace),
    });
    session.layers.register({
      key: "devtools/views.visualChanges",
      deps: ["devtools/trace"],
      build: async () => buildVisualChanges(trace),
    });
    session.layers.register({
      key: "code/dims.sourceMaps",
      deps: ["devtools/trace"],
      build: async () => buildSourceMaps(trace),
    });
    session.layers.register({
      key: "code/dims.sources",
      deps: ["devtools/trace"],
      build: async () => buildSources(trace),
    });

    session.registerRawRows("devtools.raw.events", async () => trace.traceEvents);

    session.registerTable(
      createTable(
        "devtools.raw.events",
        "Raw DevTools trace events",
        [
          { name: "name", type: "string" },
          { name: "ph", type: "string" },
          { name: "pid", type: "number" },
          { name: "tid", type: "number" },
          { name: "ts", type: "number", unit: "µs" },
        ],
        (traceValue) => traceValue.traceEvents,
      ),
    );
    session.registerTable({
      name: "devtools.facts.events",
      description: "Normalized DevTools event facts",
      columns: [
        { name: "eventId", type: "string" },
        { name: "name", type: "string" },
        { name: "phase", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
        { name: "durUs", type: "number", unit: "µs" },
        { name: "requestId", type: "string" },
        { name: "scriptId", type: "string" },
        { name: "interactionId", type: "string" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/facts.events");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.facts.instantEvents",
      description: "Instant and metadata-oriented facts",
      columns: [
        { name: "eventId", type: "string" },
        { name: "name", type: "string" },
        { name: "phase", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
      ],
      async rows(sessionRef) {
        return sessionRef.layers.get<any[]>("devtools/facts.instantEvents");
      },
    });
    session.registerTable({
      name: "devtools.facts.sliceEvents",
      description: "Duration slice facts",
      columns: [
        { name: "eventId", type: "string" },
        { name: "name", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
        { name: "durUs", type: "number", unit: "µs" },
      ],
      async rows(sessionRef) {
        return sessionRef.layers.get<any[]>("devtools/facts.sliceEvents");
      },
    });
    session.registerTable({
      name: "devtools.facts.asyncFlows",
      description: "Async/flow/object-id oriented facts",
      columns: [
        { name: "eventId", type: "string" },
        { name: "phase", type: "string" },
        { name: "id", type: "string" },
        { name: "flowScope", type: "string" },
      ],
      async rows(sessionRef) {
        return sessionRef.layers.get<any[]>("devtools/facts.asyncFlows");
      },
    });
    session.registerTable({
      name: "devtools.facts.objectLifecycles",
      description: "Lifecycle summaries for repeated object/flow IDs",
      columns: [
        { name: "objectId", type: "string" },
        { name: "firstTsUs", type: "number", unit: "µs" },
        { name: "lastTsUs", type: "number", unit: "µs" },
        { name: "eventCount", type: "number" },
      ],
      async rows(sessionRef) {
        return sessionRef.layers.get<any[]>("devtools/facts.objectLifecycles");
      },
    });
    session.registerTable({
      name: "devtools.facts.cpuSamples",
      description: "Decoded CPU profile samples from ProfileChunk events",
      columns: [
        { name: "sampleId", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
        { name: "timeDeltaUs", type: "number", unit: "µs" },
        { name: "functionName", type: "string" },
        { name: "url", type: "string" },
      ],
      async rows(sessionRef) {
        return sessionRef.layers.get<any[]>("devtools/facts.cpuSamples");
      },
    });
    session.registerTable({
      name: "devtools.dims.processes",
      description: "Processes observed in trace metadata/events",
      columns: [
        { name: "processId", type: "string" },
        { name: "processName", type: "string" },
        { name: "threadCount", type: "number" },
        { name: "eventCount", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.processes");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.threads",
      description: "Threads grouped by process",
      columns: [
        { name: "threadKey", type: "string" },
        { name: "threadName", type: "string" },
        { name: "processName", type: "string" },
        { name: "eventCount", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.threads");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.frames",
      description: "Frames inferred from frame-scoped events",
      columns: [
        { name: "frameId", type: "string" },
        { name: "url", type: "string" },
        { name: "eventCount", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.frames");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.workers",
      description: "Workers inferred from worker IDs or worker-named threads",
      columns: [
        { name: "workerId", type: "string" },
        { name: "threadCount", type: "number" },
        { name: "urls", type: "array" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.workers");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.layers",
      description: "Layer/compositor-like entities inferred from layer IDs",
      columns: [
        { name: "layerId", type: "string" },
        { name: "eventCount", type: "number" },
        { name: "eventNames", type: "array" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.layers");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.requests",
      description: "Reconstructed network requests",
      columns: [
        { name: "requestId", type: "string" },
        { name: "url", type: "string" },
        { name: "statusCode", type: "number" },
        { name: "durationMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.requests");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.requestBodies",
      description: "Embedded request/response bodies extracted from trace payloads",
      columns: [
        { name: "requestBodyId", type: "string" },
        { name: "requestId", type: "string" },
        { name: "mediaType", type: "string" },
        { name: "sizeBytes", type: "number", unit: "bytes" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.requestBodies");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.screenshots",
      description: "Screenshots embedded in the trace",
      columns: [
        { name: "screenshotId", type: "string" },
        { name: "artifactId", type: "string" },
        { name: "timestampMs", type: "number", unit: "ms" },
        { name: "sizeBytes", type: "number", unit: "bytes" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.screenshots");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.interactions",
      description: "Deduplicated user interactions derived from EventTiming",
      columns: [
        { name: "interactionId", type: "string" },
        { name: "type", type: "string" },
        { name: "durationMs", type: "number", unit: "ms" },
        { name: "startTsUs", type: "number", unit: "µs" },
        { name: "endTsUs", type: "number", unit: "µs" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.interactions");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.tasks",
      description: "Main-thread task entities on renderer main threads",
      columns: [
        { name: "taskId", type: "string" },
        { name: "durationMs", type: "number", unit: "ms" },
        { name: "functionCalls", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.tasks");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.scripts",
      description: "Scripts observed in runtime/source rundown events",
      columns: [
        { name: "scriptId", type: "string" },
        { name: "url", type: "string" },
        { name: "hasSourceText", type: "boolean" },
        { name: "sourceMapId", type: "string" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.scripts");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.layoutShifts",
      description: "Layout shifts observed in the trace",
      columns: [
        { name: "layoutShiftId", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
        { name: "score", type: "number" },
        { name: "cumulativeScore", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.layoutShifts");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.softNavigations",
      description: "Soft navigation contexts inferred from SoftNavigation events",
      columns: [
        { name: "softNavigationId", type: "string" },
        { name: "startTsUs", type: "number", unit: "µs" },
        { name: "durationMs", type: "number", unit: "ms" },
        { name: "domModifications", type: "number" },
        { name: "taskId", type: "string" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.softNavigations");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.dims.cpuNodes",
      description: "Canonical CPU profile nodes with self/total metrics",
      columns: [
        { name: "cpuNodeId", type: "string" },
        { name: "functionName", type: "string" },
        { name: "url", type: "string" },
        { name: "selfTimeMs", type: "number", unit: "ms" },
        { name: "totalTimeMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/dims.cpuNodes");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.renderMeasures",
      description: "Parsed render measures derived from blink.user_timing and UserTiming::Measure",
      columns: [
        { name: "renderMeasureId", type: "string" },
        { name: "componentName", type: "string" },
        { name: "durationMs", type: "number", unit: "ms" },
        { name: "track", type: "string" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.renderMeasures");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.renderComponentHotspots",
      description: "Aggregated render metrics by component",
      columns: [
        { name: "componentName", type: "string" },
        { name: "renderCount", type: "number" },
        { name: "totalDurationMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.renderComponentHotspots");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.interactionRenders",
      description: "Render-measure aggregates scoped to interaction windows",
      columns: [
        { name: "interactionId", type: "string" },
        { name: "componentName", type: "string" },
        { name: "renderCount", type: "number" },
        { name: "totalDurationMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.interactionRenders");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.framePipeline",
      description: "Frame pipeline rows derived from PipelineReporter events",
      columns: [
        { name: "frameReportId", type: "string" },
        { name: "frameSequence", type: "string" },
        { name: "state", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.framePipeline");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.mainThreadTasks",
      description: "Main-thread task windows on renderer main thread",
      columns: [
        { name: "taskId", type: "string" },
        { name: "durationMs", type: "number", unit: "ms" },
        { name: "functionCalls", type: "number" },
        { name: "layouts", type: "number" },
        { name: "paints", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.mainThreadTasks");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.codeHotspots",
      description: "Aggregated script/function hotspots from FunctionCall and EvaluateScript",
      columns: [
        { name: "hotspotId", type: "string" },
        { name: "url", type: "string" },
        { name: "functionName", type: "string" },
        { name: "totalDurationMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.codeHotspots");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.cpuHotspots",
      description: "Aggregated hotspots from CPU profile chunks",
      columns: [
        { name: "cpuHotspotId", type: "string" },
        { name: "functionName", type: "string" },
        { name: "url", type: "string" },
        { name: "sampleCount", type: "number" },
        { name: "selfTimeMs", type: "number", unit: "ms" },
        { name: "totalTimeMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.cpuHotspots");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.cpuCallTrees",
      description: "Folded CPU stacks aggregated from CPU samples",
      columns: [
        { name: "stackId", type: "string" },
        { name: "stackLabel", type: "string" },
        { name: "sampleCount", type: "number" },
        { name: "totalTimeMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.cpuCallTrees");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.cpuTimeline",
      description: "Bucketed CPU sample activity over time",
      columns: [
        { name: "bucketId", type: "string" },
        { name: "startTsUs", type: "number", unit: "µs" },
        { name: "sampleCount", type: "number" },
        { name: "totalTimeMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.cpuTimeline");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.interactionCpuHotspots",
      description: "CPU hotspots scoped to interaction windows",
      columns: [
        { name: "interactionCpuHotspotId", type: "string" },
        { name: "scopeId", type: "string" },
        { name: "functionName", type: "string" },
        { name: "totalTimeMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.interactionCpuHotspots");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.taskCpuHotspots",
      description: "CPU hotspots scoped to main-thread tasks",
      columns: [
        { name: "taskCpuHotspotId", type: "string" },
        { name: "scopeId", type: "string" },
        { name: "functionName", type: "string" },
        { name: "totalTimeMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.taskCpuHotspots");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.interactionWindows",
      description: "Interaction windows enriched with related counts",
      columns: [
        { name: "interactionId", type: "string" },
        { name: "renderCount", type: "number" },
        { name: "requestCount", type: "number" },
        { name: "droppedFrameCount", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.interactionWindows");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.networkWaterfall",
      description: "Network waterfall rows derived from reconstructed requests",
      columns: [
        { name: "requestWaterfallId", type: "string" },
        { name: "requestId", type: "string" },
        { name: "url", type: "string" },
        { name: "startOffsetMs", type: "number", unit: "ms" },
        { name: "durationMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.networkWaterfall");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.layoutShiftClusters",
      description: "Clustered layout-shift sessions",
      columns: [
        { name: "layoutShiftClusterId", type: "string" },
        { name: "shiftCount", type: "number" },
        { name: "totalScore", type: "number" },
        { name: "durationMs", type: "number", unit: "ms" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.layoutShiftClusters");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "devtools.views.visualChanges",
      description: "Ordered list of screenshots, paints, and layout shifts",
      columns: [
        { name: "changeId", type: "string" },
        { name: "kind", type: "string" },
        { name: "tsUs", type: "number", unit: "µs" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("devtools/views.visualChanges");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "code.dims.sourceMaps",
      description: "Source maps embedded in trace metadata",
      columns: [
        { name: "sourceMapId", type: "string" },
        { name: "url", type: "string" },
        { name: "sourceMapUrl", type: "string" },
        { name: "sourceCount", type: "number" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("code/dims.sourceMaps");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });
    session.registerTable({
      name: "code.dims.sources",
      description: "Original sources embedded in source maps",
      columns: [
        { name: "sourceId", type: "string" },
        { name: "sourcePath", type: "string" },
        { name: "sizeBytes", type: "number", unit: "bytes" },
        { name: "hasContent", type: "boolean" },
      ],
      async rows(sessionRef, options) {
        const rows = await sessionRef.layers.get<any[]>("code/dims.sources");
        return options?.limit ? rows.slice(0, options.limit) : rows;
      },
    });

    session.registerReport(
      createReport(
        "devtools.summary",
        "High-level DevTools trace summary",
        (traceValue) => buildSummary(traceValue),
        (traceValue) => prettySummaryReport(traceValue),
      ),
    );
    session.registerReport(
      createReport(
        "devtools.interaction",
        "Detailed interaction report",
        (traceValue, args) =>
          buildInteractionReport(traceValue, typeof args?.id === "string" ? args.id : undefined),
        (traceValue, args) => prettyInteractionReport(traceValue, args),
      ),
    );
    session.registerReport(
      createReport(
        "devtools.frame",
        "Frame pipeline report",
        (traceValue, args) => buildFrameReport(traceValue, args),
        (traceValue, args) => prettyFrameReport(traceValue, args),
      ),
    );
    session.registerReport(
      createReport(
        "devtools.request",
        "Request-centric report",
        (traceValue, args) => buildRequestReport(traceValue, args),
        (traceValue, args) => prettyRequestReport(traceValue, args),
      ),
    );
    session.registerReport(
      createReport(
        "devtools.soft-navigation",
        "Soft-navigation report",
        (traceValue, args) => buildSoftNavigationReport(traceValue, args),
        (traceValue, args) => prettySoftNavigationReport(traceValue, args),
      ),
    );
    session.registerReport(
      createReport(
        "devtools.hotspots",
        "Combined code and CPU hotspot summary",
        (traceValue) => buildHotspotsReport(traceValue),
        (traceValue) => prettyHotspotsReport(traceValue),
      ),
    );
    session.registerReport(
      createReport(
        "devtools.script",
        "Script-centric report with source and hotspot attribution",
        (traceValue, args) => buildScriptReport(traceValue, args),
        (traceValue, args) => prettyScriptReport(traceValue, args),
      ),
    );

    session.registerArtifactProvider(new DevtoolsArtifactProvider(trace));
    session.registerCollection(screenshotCollection);
    session.registerCollection(scriptsCollection);
    session.registerCollection(sourceMapsCollection);
    session.registerCollection(sourcesCollection);
    session.registerCollection(requestBodiesCollection);

    session.registerNamespace("devtools", {
      interactions: {
        rows: async () => session.getTable("devtools.dims.interactions")!.rows(session),
        windows: async () => session.getTable("devtools.views.interactionWindows")!.rows(session),
        cpuHotspots: async () =>
          session.getTable("devtools.views.interactionCpuHotspots")!.rows(session),
        renders: async () => session.getTable("devtools.views.interactionRenders")!.rows(session),
      },
      frames: {
        rows: async () => session.getTable("devtools.views.framePipeline")!.rows(session),
      },
      tasks: {
        rows: async () => session.getTable("devtools.dims.tasks")!.rows(session),
        cpuHotspots: async () => session.getTable("devtools.views.taskCpuHotspots")!.rows(session),
      },
      code: {
        hotspots: async () => session.getTable("devtools.views.codeHotspots")!.rows(session),
        cpuHotspots: async () => session.getTable("devtools.views.cpuHotspots")!.rows(session),
        cpuSamples: async () => session.getTable("devtools.facts.cpuSamples")!.rows(session),
      },
      network: {
        requests: async () => session.getTable("devtools.dims.requests")!.rows(session),
        waterfall: async () => session.getTable("devtools.views.networkWaterfall")!.rows(session),
        bodies: async () => session.getTable("devtools.dims.requestBodies")!.rows(session),
      },
      report: {
        summary: async () => session.getReport("devtools.summary")!.run(session),
        interaction: async (id?: string) =>
          session.getReport("devtools.interaction")!.run(session, id ? { id } : {}),
        frame: async (frameSequence?: string) =>
          session.getReport("devtools.frame")!.run(session, frameSequence ? { frameSequence } : {}),
        request: async (requestId?: string, url?: string) =>
          session.getReport("devtools.request")!.run(session, {
            ...(requestId ? { requestId } : {}),
            ...(url ? { url } : {}),
          }),
        softNavigation: async (softNavigationId?: string) =>
          session
            .getReport("devtools.soft-navigation")!
            .run(session, softNavigationId ? { softNavigationId } : {}),
        hotspots: async () => session.getReport("devtools.hotspots")!.run(session),
        script: async (scriptId?: string, url?: string) =>
          session.getReport("devtools.script")!.run(session, {
            ...(scriptId ? { scriptId } : {}),
            ...(url ? { url } : {}),
          }),
      },
      files: {
        screenshots: async () => session.exportCollection("devtools.screenshots"),
        scripts: async () => session.exportCollection("devtools.scripts"),
        networkBodies: async () => session.exportCollection("devtools.network-bodies"),
      },
      indexes: {
        secondary: async () => session.layers.get("devtools/indexes.secondary"),
      },
    });

    session.registerNamespace("code", {
      sourceMaps: {
        rows: async () => session.getTable("code.dims.sourceMaps")!.rows(session),
      },
      sources: {
        rows: async () => session.getTable("code.dims.sources")!.rows(session),
      },
      files: {
        sourceMaps: async () => session.exportCollection("code.source-maps"),
        sources: async () => session.exportCollection("code.sources"),
      },
    });

    session.setId(hashFilePath(sourcePath));
    return session;
  }
}
