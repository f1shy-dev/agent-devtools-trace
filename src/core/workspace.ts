import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "fs";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import type { LeaseInfo } from "../shared/types.js";
import { WORKSPACE_LEASE_TTL_MS, WORKSPACE_ROOT } from "../shared/constants.js";

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "item"
  );
}

function nowIso() {
  return new Date().toISOString();
}

function sizeIfExists(path: string) {
  try {
    return existsSync(path) ? statSync(path).size : undefined;
  } catch {
    return undefined;
  }
}

export class WorkspaceManager {
  private rootPath: string;
  private readonly leases = new Map<string, LeaseInfo>();

  constructor(private readonly sessionId: string) {
    this.rootPath = join(WORKSPACE_ROOT, sessionId);
    mkdirSync(join(this.rootPath, "scratch"), { recursive: true });
    mkdirSync(join(this.rootPath, "exports"), { recursive: true });
  }

  private pruneExpired() {
    const now = Date.now();
    for (const lease of this.leases.values()) {
      if (lease.status !== "active" || lease.pinned || !lease.expiresAt) continue;
      if (Date.parse(lease.expiresAt) <= now) {
        void this.releaseLease(lease.leaseId);
      }
    }
  }

  private createLease(kind: LeaseInfo["kind"], purpose: string, path: string) {
    this.pruneExpired();
    const createdAt = nowIso();
    const lease: LeaseInfo = {
      leaseId: randomUUID(),
      kind,
      purpose,
      path,
      createdAt,
      pinned: false,
      status: "active",
      bytes: sizeIfExists(path),
      expiresAt: new Date(Date.now() + WORKSPACE_LEASE_TTL_MS).toISOString(),
    };
    this.leases.set(lease.leaseId, lease);
    return lease;
  }

  getRoot() {
    return this.rootPath;
  }

  async allocScratchDir(purpose: string) {
    const path = await mkdtemp(join(this.rootPath, `scratch/${slugify(purpose)}-`));
    const lease = this.createLease("scratch", purpose, path);
    return { path, leaseId: lease.leaseId };
  }

  async allocScratchFile(purpose: string, ext = "") {
    const dir = await this.allocScratchDir(purpose);
    const path = join(
      dir.path,
      `${slugify(purpose)}${ext.startsWith(".") || ext.length === 0 ? ext : `.${ext}`}`,
    );
    await writeFile(path, "");
    this.updateLeaseBytes(dir.leaseId, sizeIfExists(path));
    return { path, leaseId: dir.leaseId };
  }

  async allocExportDir(purpose: string) {
    const path = await mkdtemp(join(this.rootPath, `exports/${slugify(purpose)}-`));
    const lease = this.createLease("export", purpose, path);
    return { path, leaseId: lease.leaseId };
  }

  updateLeaseBytes(leaseId: string, bytes?: number) {
    const lease = this.leases.get(leaseId);
    if (!lease) return;
    lease.bytes = bytes;
  }

  writeManifest(dir: string, manifest: unknown) {
    const manifestPath = join(dir, "manifest.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return manifestPath;
  }

  async releaseLease(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease || lease.status === "released") {
      return { ok: false, leaseId };
    }
    if (lease.pinned) {
      return { ok: false, leaseId };
    }
    rmSync(lease.path, { recursive: true, force: true });
    lease.status = "released";
    lease.bytes = undefined;
    return { ok: true, leaseId };
  }

  async pinLease(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    lease.pinned = true;
    return { ...lease };
  }

  async unpinLease(leaseId: string) {
    const lease = this.leases.get(leaseId);
    if (!lease) return null;
    lease.pinned = false;
    return { ...lease };
  }

  async listLeases() {
    this.pruneExpired();
    return [...this.leases.values()].map((lease) => ({ ...lease }));
  }

  dispose() {
    rmSync(this.rootPath, { recursive: true, force: true });
    for (const lease of this.leases.values()) {
      lease.status = "released";
      lease.bytes = undefined;
    }
  }
}

export function sanitizeFilename(value: string) {
  return slugify(value);
}

export function guessExtension(mediaType: string, fallback = "bin") {
  const normalized = mediaType.split(";")[0]?.trim().toLowerCase();
  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/svg+xml": "svg",
    "image/bmp": "bmp",
    "image/x-icon": "ico",
    "image/avif": "avif",
    "application/json": "json",
    "application/source-map+json": "json",
    "application/pdf": "pdf",
    "application/xml": "xml",
    "application/zip": "zip",
    "application/gzip": "gz",
    "application/wasm": "wasm",
    "text/javascript": "js",
    "text/plain": "txt",
    "text/html": "html",
    "text/css": "css",
    "text/xml": "xml",
    "text/csv": "csv",
    "font/woff": "woff",
    "font/woff2": "woff2",
  };
  return (normalized && extensions[normalized]) ?? fallback;
}
