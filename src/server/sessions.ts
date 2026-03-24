import { createHash } from "crypto";
import type { DatasetSession as DatasetSessionContract } from "../core/types.js";
import type { SessionInfo } from "../shared/types.js";

export class SessionManager {
  private readonly sessions = new Map<string, DatasetSessionContract>();

  create(session: DatasetSessionContract, alias?: string) {
    const id = this.generateId(session.manifest.source);
    session.setId(id);
    session.alias = alias;
    this.sessions.set(id, session);
    return session;
  }

  list() {
    return [...this.sessions.values()].map<SessionInfo>((session) => ({
      ...session.manifest,
      alias: session.alias,
      memorySizeMB: session.memorySizeMB,
    }));
  }

  get(id: string) {
    const direct = this.sessions.get(id);
    if (direct) return direct;
    for (const session of this.sessions.values()) {
      if (session.alias === id) return session;
    }
    return undefined;
  }

  unload(id: string) {
    const direct = this.sessions.get(id);
    if (direct) {
      this.sessions.delete(id);
      void direct.dispose();
      return true;
    }
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.alias === id) {
        this.sessions.delete(sessionId);
        void session.dispose();
        return true;
      }
    }
    return false;
  }

  count() {
    return this.sessions.size;
  }

  clear() {
    for (const session of this.sessions.values()) {
      void session.dispose();
    }
    this.sessions.clear();
  }

  private generateId(file: string) {
    const hash = createHash("sha256").update(file).digest("hex").slice(0, 8);
    if (!this.sessions.has(hash)) return hash;
    let suffix = 1;
    while (this.sessions.has(`${hash}-${suffix}`)) suffix++;
    return `${hash}-${suffix}`;
  }
}

export const sessionManager = new SessionManager();
