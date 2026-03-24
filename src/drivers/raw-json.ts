import { createHash } from "crypto";
import { basename } from "path";
import { DatasetSession } from "../core/dataset-session.js";
import { pretty as prettyValue } from "../core/presentation.js";
import { readMaybeGzipText } from "../core/io.js";
import {
  detectTimeLikePaths,
  discoverJsonPaths,
  findEmbeddedBlobs,
} from "../core/json-introspect.js";
import type {
  ArtifactProvider,
  ReportProvider,
  SourceDetection,
  SourceDriver,
  SourceProbe,
  TableProvider,
} from "../core/types.js";
import type { CapabilityMap, TableColumn } from "../shared/types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function hashFilePath(filePath: string) {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 8);
}

async function parseJson(filePath: string) {
  return JSON.parse(await readMaybeGzipText(filePath));
}

function tableNameForPath(path: string) {
  if (path === "$") return "raw.inferred.main";
  const suffix = path
    .replace(/^\$\.?/, "")
    .replace(/\[\]/g, "")
    .replace(/\[[0-9]+\]/g, "")
    .split(".")
    .filter(Boolean)
    .join(".");
  return `raw.inferred.${suffix || "main"}`;
}

function inferColumns(rows: unknown[]): TableColumn[] {
  const firstRecord = rows.find((row) => isRecord(row));
  if (firstRecord && isRecord(firstRecord)) {
    const keys = new Set<string>();
    rows.filter(isRecord).forEach((row) => Object.keys(row).forEach((key) => keys.add(key)));
    return [...keys].map((key) => ({
      name: key,
      type: typeOfValue((firstRecord as Record<string, unknown>)[key]),
    }));
  }
  return [
    { name: "index", type: "number" },
    { name: "value", type: typeOfValue(rows[0]) },
  ];
}

function normalizeRows(rows: unknown[]) {
  if (rows.every(isRecord)) return rows;
  return rows.map((value, index) => ({ index, value }));
}

function inferTables(payload: unknown) {
  const tables: Array<{
    name: string;
    path: string;
    description: string;
    rows: unknown[];
    columns: TableColumn[];
  }> = [];
  const seen = new Set<string>();

  const visit = (current: unknown, path: string) => {
    if (Array.isArray(current) && current.length > 0) {
      const name = tableNameForPath(path);
      let finalName = name;
      let suffix = 1;
      while (seen.has(finalName)) {
        suffix += 1;
        finalName = `${name}.${suffix}`;
      }
      seen.add(finalName);
      const rows = normalizeRows(current);
      tables.push({
        name: finalName,
        path,
        description:
          path === "$"
            ? "Top-level array inferred from the raw dataset"
            : `Inferred table from path '${path}'`,
        rows,
        columns: inferColumns(rows),
      });
    }

    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, `${path}[]`));
      return;
    }
    if (isRecord(current)) {
      for (const [key, value] of Object.entries(current)) {
        visit(value, path === "$" ? `$.${key}` : `${path}.${key}`);
      }
    }
  };

  visit(payload, "$");
  return tables;
}

function buildEmbeddedBlobRows(payload: unknown) {
  return findEmbeddedBlobs(payload).map((blob, index) => ({
    embeddedBlobId: `embedded-blob:${index}`,
    artifactId: `artifact:raw:embedded:${index}`,
    path: blob.path,
    mediaType: blob.mediaType,
    sizeBytes: blob.bytes.byteLength,
    filename: blob.filenameHint ?? `embedded-${String(index).padStart(4, "0")}.bin`,
    bytes: blob.bytes,
    confidence: blob.confidence,
    encoding: blob.encoding,
    decodedKind: blob.decodedKind,
    containerKind: blob.containerKind,
    hash: createHash("sha256").update(blob.bytes).digest("hex"),
  }));
}

class RawArtifactProvider implements ArtifactProvider {
  id = "raw-artifact-provider";
  private readonly embeddedBlobs: ReturnType<typeof buildEmbeddedBlobRows>;

  constructor(
    private readonly payload: unknown,
    private readonly sourcePath: string,
  ) {
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
        kind:
          blob.decodedKind === "binary"
            ? ("binary" as const)
            : blob.decodedKind === "json"
              ? ("json" as const)
              : ("text" as const),
        mediaType: blob.mediaType,
        sizeBytes: blob.sizeBytes,
        filenameHint: blob.filename,
        hash: blob.hash,
        metadata: {
          path: blob.path,
          confidence: blob.confidence,
          encoding: blob.encoding,
          decodedKind: blob.decodedKind,
          containerKind: blob.containerKind,
        },
      })),
    ];
  }

  canHandle(artifactId: string) {
    return (
      artifactId === "artifact:raw:document" || artifactId.startsWith("artifact:raw:embedded:")
    );
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
    if (row.decodedKind === "json") {
      return {
        kind: "json" as const,
        mediaType: row.mediaType,
        json: JSON.parse(Buffer.from(row.bytes).toString("utf8")),
      };
    }
    if (row.decodedKind === "text") {
      return {
        kind: "text" as const,
        mediaType: row.mediaType,
        text: Buffer.from(row.bytes).toString("utf8"),
      };
    }
    return {
      kind: "binary" as const,
      mediaType: row.mediaType,
      bytes: row.bytes,
    };
  }
}

function createRawSummaryReport(
  payload: unknown,
  inferredTables: ReturnType<typeof inferTables>,
  pathCatalog: ReturnType<typeof discoverJsonPaths>,
  timeFields: string[],
  embeddedBlobs: ReturnType<typeof buildEmbeddedBlobRows>,
): ReportProvider {
  return {
    name: "raw.summary",
    description: "Summary of inferred raw JSON structure",
    async run() {
      return {
        topLevelType: Array.isArray(payload) ? "array" : typeof payload,
        inferredTables: inferredTables.map((table) => ({
          name: table.name,
          rows: table.rows.length,
          path: table.path,
        })),
        pathCount: pathCatalog.length,
        timeFields,
        embeddedBlobCount: embeddedBlobs.length,
      };
    },
    async pretty() {
      return prettyValue({
        topLevelType: Array.isArray(payload) ? "array" : typeof payload,
        pathCount: pathCatalog.length,
        inferredTables: inferredTables.map((table) => `${table.name} (${table.rows.length} rows)`),
        timeFields,
        embeddedBlobCount: embeddedBlobs.length,
      });
    },
  };
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
      nestedInferredTables: inferredTables.filter((table) => table.path.includes(".")).length,
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
      const provider: TableProvider = {
        name: table.name,
        description: table.description,
        columns: table.columns,
        async rows() {
          return table.rows;
        },
      };
      session.registerTable(provider);
      session.registerRawRows(table.name, async () => table.rows);
    }

    session.registerTable({
      name: "raw.schema.paths",
      description: "Discovered JSON paths in the raw document",
      columns: [
        { name: "path", type: "string" },
        { name: "count", type: "number" },
        { name: "types", type: "array" },
        { name: "samples", type: "array" },
      ],
      async rows() {
        return pathCatalog;
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
        { name: "confidence", type: "string" },
        { name: "encoding", type: "string" },
        { name: "decodedKind", type: "string" },
        { name: "containerKind", type: "string" },
      ],
      async rows() {
        return embeddedBlobs;
      },
    });

    session.registerReport(
      createRawSummaryReport(payload, inferredTables, pathCatalog, timeFields, embeddedBlobs),
    );

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
          metadata: {
            path: blob.path,
            mediaType: blob.mediaType,
            confidence: blob.confidence,
            encoding: blob.encoding,
            decodedKind: blob.decodedKind,
          },
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
