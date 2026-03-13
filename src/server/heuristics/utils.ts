import type { Session, TraceEvent } from "../../shared/types";

export function getThreadKey(pid: number, tid: number): string {
  return `${pid}:${tid}`;
}

export function splitCategories(categoryValue: string | undefined): string[] {
  if (!categoryValue) {
    return [];
  }

  return categoryValue
    .split(",")
    .map((category) => category.trim())
    .filter((category) => category.length > 0);
}

export function getTraceBounds(events: TraceEvent[]): { minTs: number; maxTs: number } {
  if (events.length === 0) {
    return { minTs: 0, maxTs: 0 };
  }

  let minTs = Number.POSITIVE_INFINITY;
  let maxTs = Number.NEGATIVE_INFINITY;

  for (const event of events) {
    const start = event.ts;
    const end = event.ts + (event.dur ?? 0);
    if (start < minTs) {
      minTs = start;
    }
    if (end > maxTs) {
      maxTs = end;
    }
  }

  return {
    minTs: Number.isFinite(minTs) ? minTs : 0,
    maxTs: Number.isFinite(maxTs) ? maxTs : 0,
  };
}

export function getThreadMetadata(events: TraceEvent[]): {
  threadNames: Map<string, string>;
  processNames: Map<number, string>;
} {
  const threadNames = new Map<string, string>();
  const processNames = new Map<number, string>();

  for (const event of events) {
    if (event.ph !== "M") {
      continue;
    }

    const name =
      typeof event.args?.name === "string"
        ? event.args.name
        : typeof event.args?.data?.name === "string"
          ? event.args.data.name
          : undefined;
    if (!name) {
      continue;
    }

    if (event.name === "thread_name") {
      threadNames.set(getThreadKey(event.pid, event.tid), name);
      continue;
    }

    if (event.name === "process_name") {
      processNames.set(event.pid, name);
    }
  }

  return { threadNames, processNames };
}

export function getTraceStartTs(session: Session): number {
  return getTraceBounds(session.trace.traceEvents).minTs;
}

export function toPercentage(count: number, total: number): number {
  if (total === 0) {
    return 0;
  }

  return Number(((count / total) * 100).toFixed(2));
}
