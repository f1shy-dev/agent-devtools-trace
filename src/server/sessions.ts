import { createHash } from "crypto";
import type { DatasetSession as DatasetSessionContract } from "../core/types.js";
import type { SessionInfo } from "../shared/types.js";

export const SESSION_ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function validateSessionAlias(alias: unknown): asserts alias is string {
  if (typeof alias !== "string" || alias.length === 0) {
    throw new Error("Alias must be a non-empty string");
  }
  if (!SESSION_ALIAS_PATTERN.test(alias)) {
    throw new Error(
      `Invalid alias '${String(alias)}': must be 1-64 alphanumeric characters, dots, hyphens, or underscores, starting with alphanumeric`,
    );
  }
}

export class SessionManager {
  private readonly sessions = new Map<string, DatasetSessionContract>();

  create(session: DatasetSessionContract, alias?: string) {
    if (alias !== undefined) {
      validateSessionAlias(alias);
      for (const existing of this.sessions.values()) {
        if (existing.alias === alias) {
          throw new Error(
            `Alias '${alias}' is already in use by session ${existing.manifest.id}`,
          );
        }
      }
    }
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
