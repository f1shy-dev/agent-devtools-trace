import { createHash } from "crypto";
import { basename } from "path";
import { DatasetSession } from "../core/dataset-session.js";
import { readMaybeGzipText } from "../core/io.js";
import {
  detectTimeLikePaths,
  discoverJsonPaths,
  findEmbeddedBlobs,
} from "../core/json-introspect.js";
import type { ArtifactProvider, SourceDetection, SourceDriver, SourceProbe } from "../core/types.js";
import type { CapabilityMap } from "../shared/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hashFilePath(filePath: string) {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 8);
}

async function parseJson(filePath: string) {
  return JSON.parse(await readMaybeGzipText(filePath));
}

function inferTables(payload: unknown) {
  const tables: Array<{ name: string; description: string; rows: unknown[]; columns: Array<{ name: string; type: string }> }> = [];
  if (Array.isArray(payload)) {
    const first = payload.find((row) => isRecord(row));
    tables.push({
      name: "raw.inferred.main",
      description: "Top-level array inferred from the raw dataset",
      rows: payload,
      columns:
        first && isRecord(first)
          ? Object.keys(first).map((key) => ({ name: key, type: typeof (first as any)[key] }))
          : [],
    });
    return tables;
  }
  if (isRecord(payload)) {
    for (const [key, value] of Object.entries(payload)) {
      if (Array.isArray(value)) {
        const first = value.find((row) => isRecord(row));
        tables.push({
          name: `raw.inferred.${key}`,
          description: `Inferred table from property '${key}'`,
          rows: value,
          columns:
            first && isRecord(first)
              ? Object.keys(first).map((column) => ({ name: column, type: typeof (first as any)[column] }))
              : [],
        });
      }
    }
  }
  return tables;
}

function buildEmbeddedBlobRows(payload: unknown) {
  return findEmbeddedBlobs(payload).map((blob, index) => ({
    embeddedBlobId: `embedded-blob:${index}`,
    artifactId: `artifact:raw:embedded:${index}`,
    path: blob.path,
    mediaType: blob.mediaType,
    sizeBytes: blob.bytes.byteLength,
    filename: `embedded-${String(index).padStart(4, "0")}.bin`,
    bytes: blob.bytes,
  }));
}

class RawArtifactProvider implements ArtifactProvider {
  id = "raw-artifact-provider";
  private readonly embeddedBlobs: ReturnType<typeof buildEmbeddedBlobRows>;

  constructor(private readonly payload: unknown, private readonly sourcePath: string) {
    this.embeddedBlobs = buildEmbeddedBlobRows(payload);
  }

  async list() {
    return [
      {
        id: "artifact:raw:document",
        kind: "json" as const,
        mediaType: "application/json",
        filenameHint: basename(this.sourcePath),
      },
      ...this.embeddedBlobs.map((blob) => ({
        id: blob.artifactId,
        kind: "binary" as const,
        mediaType: blob.mediaType,
        sizeBytes: blob.sizeBytes,
        filenameHint: blob.filename,
        metadata: { path: blob.path },
      })),
    ];
  }

  canHandle(artifactId: string) {
    return artifactId === "artifact:raw:document" || artifactId.startsWith("artifact:raw:embedded:");
  }

  async get(_session: DatasetSession, artifactId: string) {
    return (await this.list()).find((item) => item.id === artifactId) ?? null;
  }

  async read(_session: DatasetSession, artifactId: string) {
    if (artifactId === "artifact:raw:document") {
      return {
        kind: "json" as const,
        mediaType: "application/json",
        json: this.payload,
      };
    }
    const row = this.embeddedBlobs.find((blob) => blob.artifactId === artifactId);
    if (!row) return null;
    return {
      kind: "binary" as const,
      mediaType: row.mediaType,
      bytes: row.bytes,
    };
  }
}

export class RawJsonDriver implements SourceDriver {
  id = "raw-json";

  async detect(source: SourceProbe): Promise<SourceDetection | null> {
    if (source.isDirectory) return null;
    if (!source.path.endsWith(".json") && !source.path.endsWith(".json.gz")) return null;
    try {
      const payload = await parseJson(source.path);
      if (isRecord(payload) && Array.isArray((payload as any).traceEvents)) return null;
      return { kind: "raw-json", driverId: this.id };
    } catch {
      return null;
    }
  }

  async open(sourcePath: string, detection: SourceDetection) {
    const payload = await parseJson(sourcePath);
    const inferredTables = inferTables(payload);
    const pathCatalog = discoverJsonPaths(payload);
    const timeFields = detectTimeLikePaths(pathCatalog);
    const embeddedBlobs = buildEmbeddedBlobRows(payload);

    const capabilities: CapabilityMap = {
      json: true,
      inferredTables: inferredTables.length,
      embeddedBlobs: embeddedBlobs.length,
      timeFields: timeFields.length,
    };

    const session = new DatasetSession({
      sourcePath,
      detection,
      itemCount: Array.isArray(payload) ? payload.length : undefined,
      rawDocument: async () => payload,
      capabilities: async () => capabilities,
    });

    session.registerRawRows("raw.document", async () => [payload]);
    for (const table of inferredTables) {
      session.registerTable({
        name: table.name,
        description: table.description,
        columns: table.columns,
        async rows(_session, options) {
          return options?.limit ? table.rows.slice(0, options.limit) : table.rows;
        },
      });
      session.registerRawRows(table.name, async () => table.rows);
    }

    session.registerTable({
      name: "raw.schema.paths",
      description: "Discovered JSON paths in the raw document",
      columns: [
        { name: "path", type: "string" },
        { name: "count", type: "number" },
        { name: "types", type: "array" },
      ],
      async rows(_session, options) {
        return options?.limit ? pathCatalog.slice(0, options.limit) : pathCatalog;
      },
    });

    session.registerTable({
      name: "raw.embeddedBlobs",
      description: "Embedded blobs discovered in the raw document",
      columns: [
        { name: "embeddedBlobId", type: "string" },
        { name: "path", type: "string" },
        { name: "mediaType", type: "string" },
        { name: "sizeBytes", type: "number", unit: "bytes" },
      ],
      async rows(_session, options) {
        return options?.limit ? embeddedBlobs.slice(0, options.limit) : embeddedBlobs;
      },
    });

    session.registerReport({
      name: "raw.summary",
      description: "Summary of inferred raw JSON structure",
      async run() {
        return {
          topLevelType: Array.isArray(payload) ? "array" : typeof payload,
          inferredTables: inferredTables.map((table) => ({ name: table.name, rows: table.rows.length })),
          pathCount: pathCatalog.length,
          timeFields,
          embeddedBlobCount: embeddedBlobs.length,
        };
      },
    });

    session.registerArtifactProvider(new RawArtifactProvider(payload, sourcePath));
    session.registerCollection({
      id: "raw.document",
      description: "Export the original parsed JSON document",
      async listItems() {
        return [{ relativePath: basename(sourcePath), artifactId: "artifact:raw:document" }];
      },
    });
    session.registerCollection({
      id: "raw.embedded-blobs",
      description: "Export embedded blobs discovered in the raw dataset",
      async listItems() {
        return embeddedBlobs.map((blob) => ({
          relativePath: `embedded/${blob.filename}`,
          artifactId: blob.artifactId,
          metadata: { path: blob.path, mediaType: blob.mediaType },
        }));
      },
    });

    session.registerNamespace("raw", {
      report: {
        summary: async () => session.getReport("raw.summary")!.run(session),
      },
      schema: {
        paths: async () => session.schemaPaths(),
      },
      files: {
        document: async () => session.exportCollection("raw.document"),
        embeddedBlobs: async () => session.exportCollection("raw.embedded-blobs"),
      },
    });

    session.setId(hashFilePath(sourcePath));
    return session;
  }
}
