import type { DevToolsData } from "..";
import type { Session } from "../../../shared/types";
import { getThreadMetadata, getTraceBounds } from "./utils";

interface LongTask {
  name: string;
  category: string;
  durationMs: number;
  startTimeMs: number;
  pid: number;
  tid: number;
  threadName?: string;
}

export async function getLongTasks(
  data: DevToolsData,
  _session: Session,
  searchParams: URLSearchParams,
): Promise<{ thresholdMs: number; tasks: LongTask[] }> {
  const thresholdValue = Number(searchParams.get("threshold"));
  const thresholdMs = Number.isFinite(thresholdValue) && thresholdValue > 0 ? thresholdValue : 50;
  const thresholdMicros = thresholdMs * 1000;
  const { minTs } = getTraceBounds(data.trace.traceEvents);
  const { threadNames } = getThreadMetadata(data.trace.traceEvents);
  const tasks = data.trace.traceEvents
    .filter(
      (event) => event.ph === "X" && typeof event.dur === "number" && event.dur > thresholdMicros,
    )
    .map((event) => ({
      name: event.name,
      category: event.cat,
      durationMs: event.dur! / 1000,
      startTimeMs: (event.ts - minTs) / 1000,
      pid: event.pid,
      tid: event.tid,
      threadName: threadNames.get(`${event.pid}:${event.tid}`),
    }))
    .sort(
      (left, right) => right.durationMs - left.durationMs || left.startTimeMs - right.startTimeMs,
    )
    .slice(0, 100);

  return { thresholdMs, tasks };
}
