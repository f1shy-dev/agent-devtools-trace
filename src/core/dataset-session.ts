import { statSync } from "fs";
import { LayerHost } from "./layer-host.js";
import { ArtifactStore, FileCollectionStore, FileMaterializer } from "./artifacts.js";
import { WorkspaceManager } from "./workspace.js";
import type {
  ArtifactData,
  ArtifactProvider,
  DatasetQueryApi,
  DatasetSession as DatasetSessionContract,
  FileCollectionProvider,
  QueryRuntimeOptions,
  ReportProvider,
  SourceDetection,
  TableProvider,
} from "./types.js";
import type {
  ArtifactRef,
  CapabilityMap,
  DatasetManifest,
  FileCollectionInfo,
  ReportInfo,
  TableInfo,
} from "../shared/types.js";

function namespaceFromName(name: string) {
  return name.includes(".") ? name.split(".")[0]! : "default";
}

export class DatasetSession implements DatasetSessionContract {
  manifest: DatasetManifest;
  memorySizeMB: number;
  alias?: string;

  readonly layers: LayerHost;
  private readonly tables = new Map<string, TableProvider>();
  private readonly reports = new Map<string, ReportProvider>();
  private readonly artifactStore = new ArtifactStore();
  private readonly collections = new FileCollectionStore();
  private workspace: WorkspaceManager;
  private fileMaterializer: FileMaterializer;
  private readonly namespaces = new Map<string, unknown>();
  private readonly rawRowProviders = new Map<string, () => Promise<unknown[]>>();
  private readonly rawDocumentProvider: () => Promise<unknown>;
  private readonly capabilityProvider: () => Promise<CapabilityMap>;

  constructor(args: {
    sourcePath: string;
    detection: SourceDetection;
    itemCount?: number;
    rawDocument: () => Promise<unknown>;
    capabilities: () => Promise<CapabilityMap>;
  }) {
    const fileSizeBytes = statSync(args.sourcePath).size;
    this.manifest = {
      id: "pending",
      kind: args.detection.kind,
      driverId: args.detection.driverId,
      source: args.sourcePath,
      loadedAt: new Date().toISOString(),
      fileSizeBytes,
      itemCount: args.itemCount,
    };
    this.memorySizeMB = Number((process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2));
    this.layers = new LayerHost(this);
    this.rawDocumentProvider = args.rawDocument;
    this.capabilityProvider = args.capabilities;
    this.workspace = new WorkspaceManager("pending");
    this.fileMaterializer = new FileMaterializer(this.workspace, this.artifactStore, this.collections);
  }

  setId(id: string) {
    this.manifest = { ...this.manifest, id };
    this.workspace.dispose();
    this.workspace = new WorkspaceManager(id);
    this.fileMaterializer = new FileMaterializer(this.workspace, this.artifactStore, this.collections);
  }

  registerTable(provider: TableProvider) {
    this.tables.set(provider.name, provider);
  }

  registerReport(provider: ReportProvider) {
    this.reports.set(provider.name, provider);
  }

  registerArtifactProvider(provider: ArtifactProvider) {
    this.artifactStore.register(provider);
  }

  registerCollection(provider: FileCollectionProvider) {
    this.collections.register(provider);
  }

  registerNamespace(name: string, namespace: unknown) {
    this.namespaces.set(name, namespace);
  }

  registerRawRows(name: string, provider: () => Promise<unknown[]>) {
    this.rawRowProviders.set(name, provider);
  }

  async getCapabilityMap() {
    return this.capabilityProvider();
  }

  listTables(): TableInfo[] {
    return [...this.tables.values()]
      .map((table) => ({
        name: table.name,
        description: table.description,
        columns: table.columns,
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getTable(name: string) {
    return this.tables.get(name);
  }

  listReports(): ReportInfo[] {
    return [...this.reports.values()]
      .map((report) => ({ name: report.name, description: report.description }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  getReport(name: string) {
    return this.reports.get(name);
  }

  listCollections(): FileCollectionInfo[] {
    return this.collections.list();
  }

  rawDocument() {
    return this.rawDocumentProvider();
  }

  async rawRows(name: string) {
    const provider = this.rawRowProviders.get(name);
    if (!provider) {
      throw new Error(`Raw rows not found: ${name}`);
    }
    return provider();
  }

  async listArtifacts(): Promise<ArtifactRef[]> {
    return this.artifactStore.list(this);
  }

  async getArtifact(id: string) {
    return this.artifactStore.get(this, id);
  }

  async readArtifact(id: string): Promise<ArtifactData | null> {
    return this.artifactStore.read(this, id);
  }

  async materializeArtifact(artifactId: string, options?: Record<string, unknown>) {
    return this.fileMaterializer.materializeArtifact(this, artifactId, options);
  }

  async exportCollection(collectionId: string, options?: Record<string, unknown>) {
    return this.fileMaterializer.exportCollection(this, collectionId, options);
  }

  async layerStatus() {
    return this.layers.status();
  }

  createQueryApi(_options?: QueryRuntimeOptions): DatasetQueryApi {
    const session = this;
    return {
      caps: {
        all: async () => session.getCapabilityMap(),
      },
      schema: {
        kind: async () => session.manifest.kind,
        namespaces: async () =>
          [...new Set([...session.tables.keys(), ...session.reports.keys()].map(namespaceFromName))].sort(),
        tables: async () => session.listTables(),
        reports: async () => session.listReports(),
        collections: async () => session.listCollections(),
        describeTable: async (name: string) => session.listTables().find((table) => table.name === name) ?? null,
        describeReport: async (name: string) => session.listReports().find((report) => report.name === name) ?? null,
      },
      raw: {
        document: async () => session.rawDocument(),
        rows: async (name: string) => session.rawRows(name),
      },
      tables: {
        names: async () => session.listTables().map((table) => table.name),
        get: async (name: string) => {
          const provider = session.getTable(name);
          if (!provider) {
            throw new Error(`Table not found: ${name}`);
          }
          return {
            rows: async (options) => provider.rows(session, options),
            first: async () => (await provider.rows(session, { limit: 1 }))[0] ?? null,
            count: async () => (await provider.rows(session)).length,
          };
        },
      },
      reports: {
        names: async () => session.listReports().map((report) => report.name),
        run: async (name: string, args?: Record<string, unknown>) => {
          const provider = session.getReport(name);
          if (!provider) {
            throw new Error(`Report not found: ${name}`);
          }
          return provider.run(session, args);
        },
      },
      artifacts: {
        list: async () => session.listArtifacts(),
        get: async (id: string) => session.getArtifact(id),
        text: async (id: string) => {
          const value = await session.readArtifact(id);
          if (!value) throw new Error(`Artifact not found: ${id}`);
          if (value.kind === "text") return value.text ?? "";
          if (value.kind === "json") return JSON.stringify(value.json ?? null, null, 2);
          return Buffer.from(value.bytes ?? new Uint8Array()).toString("utf8");
        },
        json: async <T = unknown>(id: string) => {
          const value = await session.readArtifact(id);
          if (!value) throw new Error(`Artifact not found: ${id}`);
          if (value.kind === "json") return (value.json ?? null) as T;
          if (value.kind === "text") return JSON.parse(value.text ?? "null") as T;
          return JSON.parse(Buffer.from(value.bytes ?? new Uint8Array()).toString("utf8")) as T;
        },
        bytes: async (id: string) => {
          const value = await session.readArtifact(id);
          if (!value) throw new Error(`Artifact not found: ${id}`);
          if (value.bytes) return value.bytes;
          if (value.kind === "text") return new TextEncoder().encode(value.text ?? "");
          return new TextEncoder().encode(JSON.stringify(value.json ?? null, null, 2));
        },
      },
      files: {
        listCollections: async () => session.listCollections(),
        materializeArtifact: async (artifactId, options) => session.materializeArtifact(artifactId, options),
        exportCollection: async (collectionId, options) => session.exportCollection(collectionId, options),
      },
      workspace: {
        root: async () => session.workspace.getRoot(),
        allocScratchDir: async (purpose: string) => session.workspace.allocScratchDir(purpose),
      },
      layers: {
        status: async () => session.layerStatus(),
      },
      ns: Object.fromEntries(this.namespaces.entries()),
    };
  }

  async dispose() {
    this.workspace.dispose();
  }
}
