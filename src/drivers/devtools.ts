import { statSync } from "fs";
import { createHash } from "crypto";
import { basename } from "path";
import { DatasetSession } from "../core/dataset-session.js";
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
    const endData = isRecord(event.args?.endData) ? (event.args!.endData as Record<string, any>) : undefined;
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
      sampleTraceId: canonicalId(data?.sampleTraceId ?? data?.traceId ?? (event.args as any)?.traceId),
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
    const data = fact.args && isRecord((fact.args as any).data) ? ((fact.args as any).data as Record<string, any>) : undefined;
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
      if (typeof data?.fromServiceWorker === "boolean") row.fromServiceWorker = data.fromServiceWorker;
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
  return [...requests.values()].sort((a, b) => a.startTimeUs - b.startTimeUs || a.requestId.localeCompare(b.requestId));
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
        typeof event.args?.frame_sequence === "number" ? String(event.args.frame_sequence) : undefined,
      expectedDisplayTimeUs:
        typeof event.args?.expected_display_time === "number"
          ? event.args.expected_display_time
          : undefined,
      sizeBytes: bytes.length,
      mediaType: "image/jpeg",
      base64,
      filename: `screenshot-${String(screenshotIndex).padStart(4, "0")}.jpg`,
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
    const key = row.interactionId && row.interactionId !== "0" ? row.interactionId : `${row.type}@${row.tsUs}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }

  return [...groups.entries()].map(([key, rows]) => {
    const primary = rows.sort((a, b) => b.durationMs - a.durationMs)[0]!;
    const types = [...new Set(rows.map((row) => row.type))];
    const startTsUs = Math.min(...rows.map((row) => row.tsUs));
    const endTsUs = Math.max(...rows.map((row) => row.tsUs + row.durationMs * 1000));
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
      rawEventIds: rows.map((row) => row.eventId),
    };
  }).sort((a, b) => b.durationMs - a.durationMs || a.startTsUs - b.startTsUs);
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
      const properties = Array.isArray(detail.devtools?.properties) ? detail.devtools.properties : [];
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
      };
    })
    .filter((row) => row.componentName);
}

function buildScripts(trace: ParsedTrace) {
  const scripts = new Map<string, any>();
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps) ? (trace.metadata.sourceMaps as SourceMapEntry[]) : [];

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

  return [...scripts.values()].sort((a, b) => Number(a.scriptId) - Number(b.scriptId));
}

function buildSourceMaps(trace: ParsedTrace) {
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps) ? (trace.metadata.sourceMaps as SourceMapEntry[]) : [];
  return sourceMaps.map((entry, index) => ({
    sourceMapId: `sourcemap:${index}`,
    artifactId: `artifact:code:sourcemap:${index}`,
    url: entry.url,
    sourceMapUrl: entry.sourceMapUrl,
    sourceCount: Array.isArray(entry.sourceMap?.sources) ? entry.sourceMap!.sources.length : 0,
    hasSourcesContent: Array.isArray(entry.sourceMap?.sourcesContent),
  }));
}

function buildSources(trace: ParsedTrace) {
  const sourceMaps = Array.isArray(trace.metadata.sourceMaps) ? (trace.metadata.sourceMaps as SourceMapEntry[]) : [];
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
        artifactId: content !== undefined ? `artifact:code:source:${mapIndex}:${sourceIndex}` : undefined,
        sourceMapId: `sourcemap:${mapIndex}`,
        sourcePath: source,
        sizeBytes: content?.length ?? 0,
        hasContent: content !== undefined,
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
  return [...counts.entries()].map(([threadKey, eventCount]) => {
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
    };
  }).sort((a, b) => b.eventCount - a.eventCount || a.threadKey.localeCompare(b.threadKey));
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
    processes: new Set(trace.traceEvents.map((event) => event.pid)).size,
    screenshots: getScreenshotEvents(trace).length,
    networkRequests: buildRequests(trace).length,
    interactions: buildInteractions(trace).length,
    scripts: buildScripts(trace).length,
    sourceMaps: buildSourceMaps(trace).length,
    facts: facts.length,
  };
}

function buildInteractionReport(trace: ParsedTrace, interactionId?: string) {
  const interactions = buildInteractions(trace);
  const target = interactionId
    ? interactions.find((row) => row.interactionId === interactionId)
    : interactions[0];
  if (!target) {
    return { interaction: null, renders: [], topComponents: [], eventDispatches: [], droppedFrames: 0 };
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
        event.name === "EventDispatch" && event.ts >= target.startTsUs - 5_000 && event.ts <= target.endTsUs + 5_000,
    )
    .map(({ event, index }) => ({
      eventId: `evt:${index}`,
      type: getNestedString(event.args?.data?.type) ?? "unknown",
      tsUs: event.ts,
      durMs: (event.dur ?? 0) / 1000,
    }));
  const droppedFrames = trace.traceEvents.filter((event) => {
    if (event.name !== "PipelineReporter" || event.ts < target.startTsUs || event.ts > target.endTsUs) return false;
    const state = event.args?.frame_reporter?.state;
    return state === "STATE_DROPPED";
  }).length;
  return {
    interaction: target,
    renders: renderMeasures,
    topComponents: [...componentCounts.entries()]
      .map(([componentName, count]) => ({ componentName, count }))
      .sort((a, b) => b.count - a.count || a.componentName.localeCompare(b.componentName))
      .slice(0, 20),
    eventDispatches,
    droppedFrames,
  };
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
    return [...screenshots, ...scripts, ...sourceMaps, ...sources];
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
      const match = this.trace.traceEvents.find((event) => canonicalId(event.args?.data?.scriptId) === scriptId && typeof event.args?.data?.sourceText === "string");
      if (!match) return null;
      return {
        kind: "text",
        mediaType: "text/javascript",
        text: String(match.args!.data.sourceText),
      };
    }
    if (artifactId.startsWith("artifact:code:sourcemap:")) {
      const index = Number(artifactId.split(":").pop());
      const sourceMaps = Array.isArray(this.trace.metadata.sourceMaps) ? (this.trace.metadata.sourceMaps as SourceMapEntry[]) : [];
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
      const sourceMaps = Array.isArray(this.trace.metadata.sourceMaps) ? (this.trace.metadata.sourceMaps as SourceMapEntry[]) : [];
      const entry = sourceMaps[mapIndex];
      const content = entry?.sourceMap?.sourcesContent?.[sourceIndex];
      if (typeof content !== "string") return null;
      return {
        kind: "text",
        mediaType: "text/plain",
        text: content,
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
    inlineScriptSource: scripts.some((row) => row.hasSourceText),
    sourceMaps: sourceMaps.length > 0,
    sourceContents: sources.some((row) => row.hasContent),
    renderUserTiming: events.some((event) => splitCategories(event.cat).includes("blink.user_timing")),
    layoutShift: events.some((event) => event.name === "LayoutShift"),
    softNavigation: events.some((event) => event.name === "SoftNavigation"),
  };
}

function createTable(name: string, description: string, columns: any[], getRows: (trace: ParsedTrace) => unknown[]): TableProvider {
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

function createReport(name: string, description: string, run: (trace: ParsedTrace, args?: Record<string, unknown>) => unknown): ReportProvider {
  return {
    name,
    description,
    async run(session, args) {
      const trace = (await session.layers.get<ParsedTrace>("devtools/trace")) as ParsedTrace;
      return run(trace, args);
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

    session.layers.register({ key: "devtools/trace", build: async () => trace });
    session.layers.register({ key: "devtools/facts.events", deps: ["devtools/trace"], build: async () => buildFacts(trace) });
    session.layers.register({ key: "devtools/indexes.basic", deps: ["devtools/trace"], build: async () => buildIndexes(trace.traceEvents) });
    session.layers.register({ key: "devtools/dims.threads", deps: ["devtools/trace"], build: async () => buildThreadRows(trace) });
    session.layers.register({ key: "devtools/dims.requests", deps: ["devtools/trace"], build: async () => buildRequests(trace) });
    session.layers.register({ key: "devtools/dims.screenshots", deps: ["devtools/trace"], build: async () => buildScreenshots(trace) });
    session.layers.register({ key: "devtools/dims.interactions", deps: ["devtools/trace"], build: async () => buildInteractions(trace) });
    session.layers.register({ key: "devtools/dims.scripts", deps: ["devtools/trace"], build: async () => buildScripts(trace) });
    session.layers.register({ key: "devtools/views.renderMeasures", deps: ["devtools/trace"], build: async () => buildRenderMeasures(trace) });
    session.layers.register({ key: "code/dims.sourceMaps", deps: ["devtools/trace"], build: async () => buildSourceMaps(trace) });
    session.layers.register({ key: "code/dims.sources", deps: ["devtools/trace"], build: async () => buildSources(trace) });

    session.registerRawRows("devtools.raw.events", async () => trace.traceEvents);

    session.registerTable(createTable(
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
    ));
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

    session.registerReport(createReport("devtools.summary", "High-level DevTools trace summary", (traceValue) => buildSummary(traceValue)));
    session.registerReport(createReport("devtools.interaction", "Detailed interaction report", (traceValue, args) => buildInteractionReport(traceValue, typeof args?.id === "string" ? args.id : undefined)));

    session.registerArtifactProvider(new DevtoolsArtifactProvider(trace));
    session.registerCollection(screenshotCollection);
    session.registerCollection(scriptsCollection);
    session.registerCollection(sourceMapsCollection);
    session.registerCollection(sourcesCollection);

    session.registerNamespace("devtools", {
      interactions: {
        rows: async () => session.getTable("devtools.dims.interactions")!.rows(session),
      },
      report: {
        summary: async () => session.getReport("devtools.summary")!.run(session),
        interaction: async (id?: string) => session.getReport("devtools.interaction")!.run(session, id ? { id } : {}),
      },
      files: {
        screenshots: async () => session.exportCollection("devtools.screenshots"),
        scripts: async () => session.exportCollection("devtools.scripts"),
      },
    });

    session.setId(hashFilePath(sourcePath));
    return session;
  }
}
