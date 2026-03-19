import { randomBytes } from "crypto";
import { statSync } from "fs";
import type { TraceAdapter } from "../shared/adapter";
import type { Session } from "../shared/types";

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  create(file: string, adapter: TraceAdapter, data: unknown, alias?: string): Session {
    const id = this.generateId();
    let fileSizeBytes = 0;
    try {
      const stat = statSync(file);
      if (stat.isFile()) {
        fileSizeBytes = stat.size;
      }
    } catch {}
    const memorySizeMB = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
    const session: Session = {
      id,
      file,
      alias,
      type: adapter.type,
      data,
      adapter,
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
