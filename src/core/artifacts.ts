import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import type {
  ArtifactData,
  ArtifactProvider,
  DatasetSession,
  FileCollectionItem,
  FileCollectionProvider,
} from "./types.js";
import type {
  ArtifactRef,
  FileCollectionInfo,
  MaterializedDirectory,
  MaterializedFile,
} from "../shared/types.js";
import { guessExtension, sanitizeFilename, WorkspaceManager } from "./workspace.js";

export class ArtifactStore {
  private readonly providers: ArtifactProvider[] = [];

  register(provider: ArtifactProvider) {
    this.providers.push(provider);
  }

  async list(session: DatasetSession) {
    const items = await Promise.all(this.providers.map((provider) => provider.list(session)));
    return items.flat().sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(session: DatasetSession, artifactId: string) {
    for (const provider of this.providers) {
      if (!provider.canHandle(artifactId)) continue;
      const value = await provider.get(session, artifactId);
      if (value) return value;
    }
    return null;
  }

  async read(session: DatasetSession, artifactId: string) {
    for (const provider of this.providers) {
      if (!provider.canHandle(artifactId)) continue;
      const value = await provider.read(session, artifactId);
      if (value) return value;
    }
    return null;
  }
}

export class FileCollectionStore {
  private readonly providers = new Map<string, FileCollectionProvider>();

  register(provider: FileCollectionProvider) {
    this.providers.set(provider.id, provider);
  }

  list() {
    return [...this.providers.values()]
      .map<FileCollectionInfo>((provider) => ({
        id: provider.id,
        description: provider.description,
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  get(id: string) {
    return this.providers.get(id);
  }
}

async function materializeData(
  workspace: WorkspaceManager,
  artifact: ArtifactRef,
  data: ArtifactData,
): Promise<MaterializedFile> {
  const dir = await workspace.allocExportDir("artifact");
  const ext = guessExtension(artifact.mediaType);
  const fileName = `${sanitizeFilename(artifact.filenameHint ?? artifact.id)}.${ext}`;
  const path = join(dir.path, fileName);
  mkdirSync(dir.path, { recursive: true });

  if (data.kind === "text") {
    writeFileSync(path, data.text ?? "", "utf8");
  } else if (data.kind === "json") {
    writeFileSync(path, JSON.stringify(data.json ?? null, null, 2), "utf8");
  } else {
    writeFileSync(path, Buffer.from(data.bytes ?? new Uint8Array()));
  }

  workspace.writeManifest(dir.path, {
    type: "artifact",
    artifactId: artifact.id,
    mediaType: artifact.mediaType,
    path: fileName,
  });
  workspace.updateLeaseBytes(dir.leaseId, artifact.sizeBytes);

  return {
    kind: "file",
    path,
    artifactId: artifact.id,
    bytes: artifact.sizeBytes,
    leaseId: dir.leaseId,
  };
}

function bufferFromArtifactData(data: ArtifactData): Buffer {
  if (data.kind === "text") {
    return Buffer.from(data.text ?? "", "utf8");
  }
  if (data.kind === "json") {
    return Buffer.from(JSON.stringify(data.json ?? null, null, 2), "utf8");
  }
  return Buffer.from(data.bytes ?? new Uint8Array());
}

export class FileMaterializer {
  constructor(
    private readonly workspace: WorkspaceManager,
    private readonly artifactStore: ArtifactStore,
    private readonly collections: FileCollectionStore,
  ) {}

  async materializeArtifact(
    session: DatasetSession,
    artifactId: string,
    _options?: Record<string, unknown>,
  ): Promise<MaterializedFile> {
    const artifact = await this.artifactStore.get(session, artifactId);
    if (!artifact) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }
    const data = await this.artifactStore.read(session, artifactId);
    if (!data) {
      throw new Error(`Artifact data not found: ${artifactId}`);
    }
    return materializeData(this.workspace, artifact, data);
  }

  async exportCollection(
    session: DatasetSession,
    collectionId: string,
    options?: Record<string, unknown>,
  ): Promise<MaterializedDirectory> {
    const collection = this.collections.get(collectionId);
    if (!collection) {
      throw new Error(`Collection not found: ${collectionId}`);
    }

    const dir = await this.workspace.allocExportDir(collectionId);
    const items = await collection.listItems(session, options);
    const manifestItems: Array<FileCollectionItem & { mediaType?: string }> = [];

    for (const item of items) {
      const artifact = await this.artifactStore.get(session, item.artifactId);
      const data = await this.artifactStore.read(session, item.artifactId);
      if (!artifact || !data) {
        continue;
      }

      const targetPath = join(dir.path, item.relativePath);
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, bufferFromArtifactData(data));
      manifestItems.push({
        ...item,
        mediaType: artifact.mediaType,
        sizeBytes: artifact.sizeBytes,
      } as FileCollectionItem & { mediaType?: string; sizeBytes?: number });
    }

    const manifestPath = this.workspace.writeManifest(dir.path, {
      type: "collection",
      collectionId,
      items: manifestItems,
    });
    const totalBytes = manifestItems.reduce(
      (sum, item) => sum + Number((item as any).sizeBytes ?? 0),
      0,
    );
    this.workspace.updateLeaseBytes(dir.leaseId, totalBytes || undefined);

    return {
      kind: "directory",
      path: dir.path,
      manifestPath,
      collectionId,
      fileCount: manifestItems.length,
      leaseId: dir.leaseId,
    };
  }
}
