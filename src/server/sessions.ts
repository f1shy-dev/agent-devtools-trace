import { createHash } from "crypto";
import { statSync } from "fs";
import type { TraceAdapter } from "../shared/adapter";
import type { Session } from "../shared/types";

export class SessionManager {
  private readonly sessions = new Map<string, Session>();

  create(file: string, adapter: TraceAdapter, data: unknown, alias?: string): Session {
    const id = this.generateId(file);
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
    const session = this.sessions.get(id);
    if (session) {
      return session;
    }

    for (const entry of this.sessions.values()) {
      if (entry.alias === id) {
        return entry;
      }
    }

    return undefined;
  }

  unload(id: string): boolean {
    if (this.sessions.delete(id)) {
      return true;
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.alias === id) {
        return this.sessions.delete(sessionId);
      }
    }

    return false;
  }

  count(): number {
    return this.sessions.size;
  }

  clear(): void {
    this.sessions.clear();
  }

  private generateId(file: string): string {
    const hash = createHash("sha256").update(file).digest("hex").slice(0, 8);
    if (!this.sessions.has(hash)) {
      return hash;
    }

    let suffix = 1;
    while (this.sessions.has(`${hash}-${suffix}`)) {
      suffix++;
    }
    return `${hash}-${suffix}`;
  }
}

export const sessionManager = new SessionManager();
