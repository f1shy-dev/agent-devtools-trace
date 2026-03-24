import { createHash } from "crypto";
import { statSync } from "fs";
import { basename } from "path";
import { DatasetSession } from "../core/dataset-session.js";
import { readMaybeGzipText } from "../core/io.js";
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
      columns: first && isRecord(first)
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
          columns: first && isRecord(first)
            ? Object.keys(first).map((column) => ({ name: column, type: typeof (first as any)[column] }))
            : [],
        });
      }
    }
  }
  return tables;
}

class RawArtifactProvider implements ArtifactProvider {
  id = "raw-artifact-provider";
  constructor(private readonly payload: unknown, private readonly sourcePath: string) {}
  async list() {
    return [
      {
        id: "artifact:raw:document",
        kind: "json" as const,
        mediaType: "application/json",
        filenameHint: basename(this.sourcePath),
      },
    ];
  }
  canHandle(artifactId: string) {
    return artifactId === "artifact:raw:document";
  }
  async get() {
    return {
      id: "artifact:raw:document",
      kind: "json" as const,
      mediaType: "application/json",
      filenameHint: basename(this.sourcePath),
    };
  }
  async read() {
    return {
      kind: "json" as const,
      mediaType: "application/json",
      json: this.payload,
    };
  }
}

export class RawJsonDriver implements SourceDriver {
  id = "raw-json";

  async detect(source: SourceProbe): Promise<SourceDetection | null> {
    if (source.isDirectory) return null;
    if (!source.path.endsWith(".json") && !source.path.endsWith(".json.gz")) return null;
    try {
      await parseJson(source.path);
      return { kind: "raw-json", driverId: this.id };
    } catch {
      return null;
    }
  }

  async open(sourcePath: string, detection: SourceDetection) {
    const payload = await parseJson(sourcePath);
    const inferredTables = inferTables(payload);
    const capabilities: CapabilityMap = {
      json: true,
      inferredTables: inferredTables.length,
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

    session.registerReport({
      name: "raw.summary",
      description: "Summary of inferred raw JSON structure",
      async run() {
        return {
          topLevelType: Array.isArray(payload) ? "array" : typeof payload,
          inferredTables: inferredTables.map((table) => ({ name: table.name, rows: table.rows.length })),
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

    session.registerNamespace("raw", {
      report: {
        summary: async () => session.getReport("raw.summary")!.run(session),
      },
    });

    session.setId(hashFilePath(sourcePath));
    return session;
  }
}
