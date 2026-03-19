import type { DevToolsData } from "..";
import type { Session } from "../../../shared/types";
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

export async function getSummary(data: DevToolsData, session: Session): Promise<TraceSummary> {
  const events = data.trace.traceEvents;
  const metadata = data.trace.metadata;
  const { minTs, maxTs } = getTraceBounds(events);
  const totalEvents = events.length;
  const sourceMapCount = Array.isArray(metadata.sourceMaps) ? metadata.sourceMaps.length : 0;
  const topCategories = [...data.indexes.byCategory.entries()]
    .map(([category, categoryEvents]) => ({
      category,
      count: categoryEvents.length,
      pct: toPercentage(categoryEvents.length, totalEvents),
    }))
    .sort((left, right) => right.count - left.count || left.category.localeCompare(right.category))
    .slice(0, 10);
  const topEventNames = [...data.indexes.byName.entries()]
    .map(([name, nameEvents]) => ({ name, count: nameEvents.length }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, 15);

  return {
    file: session.file,
    totalEvents,
    durationMs: (maxTs - minTs) / 1000,
    startTime: metadata.startTime,
    categories: data.indexes.byCategory.size,
    threads: data.indexes.byThread.size,
    processes: new Set(events.map((event) => event.pid)).size,
    phases: Object.fromEntries(
      [...data.indexes.byPhase.entries()].map(([phase, phaseEvents]) => [
        phase,
        phaseEvents.length,
      ]),
    ),
    topCategories,
    topEventNames,
    hasScreenshots: data.indexes.byName.has("Screenshot"),
    screenshotCount: data.indexes.byName.get("Screenshot")?.length ?? 0,
    hasNetworkEvents: data.indexes.byName.has("ResourceSendRequest"),
    networkRequestCount: data.indexes.byName.get("ResourceSendRequest")?.length ?? 0,
    hasSourceMaps: sourceMapCount > 0,
    sourceMapCount,
    memorySizeMB: session.memorySizeMB,
  };
}
