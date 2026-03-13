import type { Session } from "../../shared/types";
import { getTraceBounds, toPercentage } from "./utils";

interface TraceSummary {
  file: string;
  totalEvents: number;
  durationMs: number;
  startTime?: string;
  categories: number;
  threads: number;
  processes: number;
  phases: Record<string, number>;
  topCategories: { category: string; count: number; pct: number }[];
  topEventNames: { name: string; count: number }[];
  hasScreenshots: boolean;
  screenshotCount: number;
  hasNetworkEvents: boolean;
  networkRequestCount: number;
  hasSourceMaps: boolean;
  sourceMapCount: number;
  memorySizeMB: number;
}

export async function getSummary(session: Session): Promise<TraceSummary> {
  const events = session.trace.traceEvents;
  const metadata = session.trace.metadata;
  const { minTs, maxTs } = getTraceBounds(events);
  const totalEvents = events.length;
  const sourceMapCount = Array.isArray(metadata.sourceMaps) ? metadata.sourceMaps.length : 0;
  const topCategories = [...session.indexes.byCategory.entries()]
    .map(([category, categoryEvents]) => ({
      category,
      count: categoryEvents.length,
      pct: toPercentage(categoryEvents.length, totalEvents),
    }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .slice(0, 10);
  const topEventNames = [...session.indexes.byName.entries()]
    .map(([name, nameEvents]) => ({ name, count: nameEvents.length }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, 15);

  return {
    file: session.file,
    totalEvents,
    durationMs: (maxTs - minTs) / 1000,
    startTime: metadata.startTime,
    categories: session.indexes.byCategory.size,
    threads: session.indexes.byThread.size,
    processes: new Set(events.map((event) => event.pid)).size,
    phases: Object.fromEntries(
      [...session.indexes.byPhase.entries()].map(([phase, phaseEvents]) => [
        phase,
        phaseEvents.length,
      ]),
    ),
    topCategories,
    topEventNames,
    hasScreenshots: session.indexes.byName.has("Screenshot"),
    screenshotCount: session.indexes.byName.get("Screenshot")?.length ?? 0,
    hasNetworkEvents: session.indexes.byName.has("ResourceSendRequest"),
    networkRequestCount: session.indexes.byName.get("ResourceSendRequest")?.length ?? 0,
    hasSourceMaps: sourceMapCount > 0,
    sourceMapCount,
    memorySizeMB: session.memorySizeMB,
  };
}
