import { randomBytes } from "crypto";
import { statSync } from "fs";
import type { ParsedTrace, Session, TraceEvent, TraceIndexes } from "../shared/types";

export function buildIndexes(events: TraceEvent[]): TraceIndexes {
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

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  create(file: string, trace: ParsedTrace, alias?: string): Session {
    const id = this.generateId();
    const indexes = buildIndexes(trace.traceEvents);
    const fileSizeBytes = statSync(file).size;
    const memorySizeMB = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
    const session: Session = {
      id,
      file,
      alias,
      trace,
      indexes,
      loadedAt: new Date(),
      fileSizeBytes,
      memorySizeMB,
    };

    this.sessions.set(id, session);
    return session;
  }

  list(): Session[] {
    return [...this.sessions.values()].sort(
      (left, right) => left.loadedAt.getTime() - right.loadedAt.getTime(),
    );
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  unload(id: string): boolean {
    return this.sessions.delete(id);
  }

  count(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  private generateId(): string {
    let id = "";
    do {
      id = randomBytes(4).toString("hex");
    } while (this.sessions.has(id));
    return id;
  }
}

export const sessionManager = new SessionManager();
