import { readFile } from "fs/promises";
import { gunzipSync } from "zlib";
import type { ParsedTrace, TraceEvent, TraceMetadata } from "../shared/types";
import type { TraceLoader } from "./types";

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

export class DevToolsLoader implements TraceLoader {
  canLoad(filePath: string): boolean {
    return filePath.endsWith(".json") || filePath.endsWith(".json.gz");
  }

  async load(filePath: string): Promise<ParsedTrace> {
    const text = await readTraceText(filePath);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to parse trace JSON: ${message}`);
    }

    return parseTracePayload(parsed);
  }
}
