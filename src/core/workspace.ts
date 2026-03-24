import { mkdirSync, rmSync, writeFileSync } from "fs";
import { mkdtemp, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { randomUUID } from "crypto";
import { WORKSPACE_ROOT } from "../shared/constants.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "item";
}

export class WorkspaceManager {
  private rootPath: string;

  constructor(private readonly sessionId: string) {
    this.rootPath = join(WORKSPACE_ROOT, sessionId);
    mkdirSync(join(this.rootPath, "scratch"), { recursive: true });
    mkdirSync(join(this.rootPath, "exports"), { recursive: true });
  }

  getRoot() {
    return this.rootPath;
  }

  async allocScratchDir(purpose: string) {
    const path = await mkdtemp(join(this.rootPath, `scratch/${slugify(purpose)}-`));
    return { path, leaseId: randomUUID() };
  }

  async allocScratchFile(purpose: string, ext = "") {
    const dir = await this.allocScratchDir(purpose);
    const path = join(dir.path, `${slugify(purpose)}${ext.startsWith(".") || ext.length === 0 ? ext : `.${ext}`}`);
    await writeFile(path, "");
    return { path, leaseId: dir.leaseId };
  }

  async allocExportDir(purpose: string) {
    const path = await mkdtemp(join(this.rootPath, `exports/${slugify(purpose)}-`));
    return { path, leaseId: randomUUID() };
  }

  writeManifest(dir: string, manifest: unknown) {
    const manifestPath = join(dir, "manifest.json");
    mkdirSync(dirname(manifestPath), { recursive: true });
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return manifestPath;
  }

  dispose() {
    rmSync(this.rootPath, { recursive: true, force: true });
  }
}

export function sanitizeFilename(value: string) {
  return slugify(value);
}

export function guessExtension(mediaType: string, fallback = "bin") {
  switch (mediaType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "application/json":
    case "application/source-map+json":
      return "json";
    case "text/javascript":
      return "js";
    case "text/plain":
      return "txt";
    default:
      return fallback;
  }
}
