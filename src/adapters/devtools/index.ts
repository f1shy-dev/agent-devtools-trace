import { readFile } from "fs/promises";
import { gunzipSync } from "zlib";
import type { EndpointContext, EndpointHandler, EndpointResult, TraceAdapter } from "../../shared/adapter";
import type { ParsedTrace, Session, TraceEvent, TraceIndexes, TraceMetadata } from "../../shared/types";
import { getCategories } from "./heuristics/categories";
import { getLongTasks } from "./heuristics/long-tasks";
import { getNetwork } from "./heuristics/network";
import { extractScreenshots, getScreenshotImage, getScreenshots } from "./heuristics/screenshots";
import { getSummary } from "./heuristics/summary";
import { getThreads } from "./heuristics/threads";

export interface DevToolsData {
  trace: ParsedTrace;
  indexes: TraceIndexes;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTracePayload(payload: unknown): ParsedTrace {
  if (Array.isArray(payload)) {
    return {
      metadata: {},
      traceEvents: payload as TraceEvent[],
    };
  }

  if (!isRecord(payload)) {
    throw new Error("Invalid trace format: expected top-level object or array");
  }

  const traceEvents = payload.traceEvents;
  if (!Array.isArray(traceEvents)) {
    throw new Error("Invalid trace format: missing traceEvents array");
  }

  const metadata = isRecord(payload.metadata)
    ? (payload.metadata as TraceMetadata)
    : ((Object.fromEntries(
        Object.entries(payload).filter(([key]) => key !== "traceEvents"),
      ) as TraceMetadata) ?? {});

  return {
    metadata,
    traceEvents: traceEvents as TraceEvent[],
  };
}

async function readTraceText(filePath: string): Promise<string> {
  const bunRuntime = globalThis.Bun;
  if (filePath.endsWith(".json.gz")) {
    const compressed = bunRuntime
      ? Buffer.from(await bunRuntime.file(filePath).arrayBuffer())
      : await readFile(filePath);
    const decompressed = bunRuntime ? bunRuntime.gunzipSync(compressed) : gunzipSync(compressed);
    return new TextDecoder().decode(decompressed);
  }

  if (bunRuntime) {
    return bunRuntime.file(filePath).text();
  }

  return readFile(filePath, "utf8");
}

function buildIndexes(events: TraceEvent[]): TraceIndexes {
  const byCategory = new Map<string, TraceEvent[]>();
  const byName = new Map<string, TraceEvent[]>();
  const byThread = new Map<string, TraceEvent[]>();
  const byPhase = new Map<string, TraceEvent[]>();

  for (const event of events) {
    const cats = event.cat ? event.cat.split(",") : [""];
    for (const cat of cats) {
      const trimmed = cat.trim();
      if (!byCategory.has(trimmed)) {
        byCategory.set(trimmed, []);
      }
      byCategory.get(trimmed)!.push(event);
    }

    if (!byName.has(event.name)) {
      byName.set(event.name, []);
    }
    byName.get(event.name)!.push(event);

    const threadKey = `${event.pid}:${event.tid}`;
    if (!byThread.has(threadKey)) {
      byThread.set(threadKey, []);
    }
    byThread.get(threadKey)!.push(event);

    if (!byPhase.has(event.ph)) {
      byPhase.set(event.ph, []);
    }
    byPhase.get(event.ph)!.push(event);
  }

  return { byCategory, byName, byThread, byPhase };
}

async function handleSummary(ctx: EndpointContext): Promise<EndpointResult> {
  return getSummary(ctx.session.data as DevToolsData, ctx.session);
}

async function handleCategories(ctx: EndpointContext): Promise<EndpointResult> {
  return getCategories(ctx.session.data as DevToolsData, ctx.session);
}

async function handleThreads(ctx: EndpointContext): Promise<EndpointResult> {
  return getThreads(ctx.session.data as DevToolsData, ctx.session);
}

async function handleNetwork(ctx: EndpointContext): Promise<EndpointResult> {
  return getNetwork(ctx.session.data as DevToolsData, ctx.session);
}

async function handleLongTasks(ctx: EndpointContext): Promise<EndpointResult> {
  return getLongTasks(ctx.session.data as DevToolsData, ctx.session, ctx.searchParams);
}

async function handleScreenshots(ctx: EndpointContext): Promise<EndpointResult> {
  const data = ctx.session.data as DevToolsData;

  if (ctx.method === "POST" && ctx.subpath === "extract") {
    const body = await ctx.readBody();
    return extractScreenshots(data, ctx.session, body);
  }

  if (ctx.subpath) {
    return getScreenshotImage(data, ctx.session, Number.parseInt(ctx.subpath, 10));
  }

  return getScreenshots(data, ctx.session);
}

export class DevToolsAdapter implements TraceAdapter<DevToolsData> {
  readonly type = "devtools";

  canLoad(filePath: string): boolean {
    return filePath.endsWith(".json") || filePath.endsWith(".json.gz");
  }

  async load(filePath: string): Promise<DevToolsData> {
    const text = await readTraceText(filePath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse trace JSON: ${message}`);
    }

    const trace = parseTracePayload(parsed);
    return {
      trace,
      indexes: buildIndexes(trace.traceEvents),
    };
  }

  getItemCount(data: DevToolsData): number {
    return data.trace.traceEvents.length;
  }

  getEndpoints(): Map<string, EndpointHandler> {
    return new Map([
      ["summary", handleSummary],
      ["categories", handleCategories],
      ["threads", handleThreads],
      ["network", handleNetwork],
      ["long-tasks", handleLongTasks],
      ["screenshots", handleScreenshots],
    ]);
  }

  buildQueryContext(data: DevToolsData): Record<string, unknown> {
    const { trace, indexes } = data;
    return {
      trace,
      events: trace.traceEvents,
      metadata: trace.metadata,
      byCategory: indexes.byCategory,
      byName: indexes.byName,
      byThread: indexes.byThread,
      byPhase: indexes.byPhase,
    };
  }
}
