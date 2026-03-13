import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { Session, TraceEvent } from "../../shared/types";
import { getTraceStartTs } from "./utils";

interface ScreenshotInfo {
  index: number;
  timestamp: number;
  timestampMs: number;
  sizeBytes: number;
  base64Length: number;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function getScreenshotEvents(session: Session): TraceEvent[] {
  return session.trace.traceEvents
    .filter(
      (event) =>
        event.name === "Screenshot" &&
        typeof event.args?.snapshot === "string" &&
        event.args.snapshot.length > 0,
    )
    .sort((left, right) => left.ts - right.ts);
}

function getSnapshotBuffer(event: TraceEvent): Buffer {
  return Buffer.from(String(event.args?.snapshot ?? ""), "base64");
}

export async function getScreenshots(session: Session): Promise<{ screenshots: ScreenshotInfo[] }> {
  const startTs = getTraceStartTs(session);
  const screenshots = getScreenshotEvents(session).map((event, index) => {
    const base64 = String(event.args?.snapshot ?? "");
    const bytes = getSnapshotBuffer(event);

    return {
      index,
      timestamp: event.ts,
      timestampMs: (event.ts - startTs) / 1000,
      sizeBytes: bytes.length,
      base64Length: base64.length,
    };
  });

  return { screenshots };
}

export function getScreenshotImage(session: Session, index: number): Response {
  if (!Number.isInteger(index) || index < 0) {
    return json({ error: `Invalid screenshot index: ${index}` }, 400);
  }

  const event = getScreenshotEvents(session)[index];
  if (!event) {
    return json({ error: `Screenshot not found: ${index}` }, 404);
  }

  return new Response(new Uint8Array(getSnapshotBuffer(event)), {
    headers: { "Content-Type": "image/jpeg" },
  });
}

export async function extractScreenshots(
  session: Session,
  body: Record<string, any> = {},
): Promise<{ dir: string; count: number; files: string[] }> {
  const outputDir =
    typeof body.outputDir === "string" && body.outputDir.length > 0
      ? body.outputDir
      : `/tmp/trace-screenshots-${session.id}`;
  mkdirSync(outputDir, { recursive: true });

  const files = getScreenshotEvents(session).map((event, index) => {
    const filePath = join(outputDir, `screenshot-${index}-${event.ts}.jpg`);
    writeFileSync(filePath, getSnapshotBuffer(event));
    return filePath;
  });

  return {
    dir: outputDir,
    count: files.length,
    files,
  };
}
