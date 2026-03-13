import type { Session } from "../../shared/types";
import { getThreadMetadata, splitCategories } from "./utils";

interface ThreadInfo {
  pid: number;
  tid: number;
  threadKey: string;
  name?: string;
  processName?: string;
  eventCount: number;
  categories: string[];
}

export async function getThreads(session: Session): Promise<{ threads: ThreadInfo[] }> {
  const { threadNames, processNames } = getThreadMetadata(session.trace.traceEvents);
  const threads = [...session.indexes.byThread.entries()]
    .map(([threadKey, events]) => {
      const [pidText, tidText] = threadKey.split(":");
      const pid = Number(pidText);
      const tid = Number(tidText);
      const categories = [...new Set(events.flatMap((event) => splitCategories(event.cat)))].sort();

      return {
        pid,
        tid,
        threadKey,
        name: threadNames.get(threadKey),
        processName: processNames.get(pid),
        eventCount: events.length,
        categories,
      };
    })
    .sort(
      (left, right) =>
        right.eventCount - left.eventCount || left.threadKey.localeCompare(right.threadKey),
    );

  return { threads };
}
