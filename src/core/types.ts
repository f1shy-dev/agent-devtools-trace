import type {
  ArtifactRef,
  CapabilityMap,
  DatasetManifest,
  FileCollectionInfo,
  JsonValue,
  ReportInfo,
  TableColumn,
  TableInfo,
} from "../shared/types.js";

export interface SourceProbe {
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
}

export interface SourceDetection {
  kind: string;
  driverId: string;
}

export interface SourceDriver {
  id: string;
  detect(source: SourceProbe): Promise<SourceDetection | null>;
  open(sourcePath: string, detection: SourceDetection): Promise<DatasetSession>;
}

export interface TableQueryOptions {
  limit?: number;
}

export interface QueryRuntimeOptions {
  signal?: AbortSignal;
}

export interface LayerContext {
  session: DatasetSession;
  signal?: AbortSignal;
  get<T>(key: string): Promise<T>;
}

export interface LayerSpec<T = unknown> {
  key: string;
  deps?: string[];
  weight?: "light" | "heavy";
  build(ctx: LayerContext): Promise<T>;
}

export interface TableProvider {
  name: string;
  description: string;
  columns: TableColumn[];
  rows(session: DatasetSession, options?: TableQueryOptions): Promise<unknown[]>;
}

export interface ReportProvider {
  name: string;
  description: string;
  run(session: DatasetSession, args?: Record<string, unknown>): Promise<unknown>;
}

export interface ArtifactData {
  kind: ArtifactRef["kind"];
  mediaType: string;
  text?: string;
  json?: JsonValue | Record<string, unknown> | unknown[] | unknown;
  bytes?: Uint8Array;
}

export interface ArtifactProvider {
  id: string;
  list(session: DatasetSession): Promise<ArtifactRef[]>;
  canHandle(artifactId: string): boolean;
  get(session: DatasetSession, artifactId: string): Promise<ArtifactRef | null>;
  read(session: DatasetSession, artifactId: string): Promise<ArtifactData | null>;
}

export interface FileCollectionItem {
  relativePath: string;
  artifactId: string;
  metadata?: Record<string, unknown>;
}

export interface FileCollectionProvider {
  id: string;
  description: string;
  listItems(
    session: DatasetSession,
    options?: Record<string, unknown>,
  ): Promise<FileCollectionItem[]>;
}

export interface DatasetQueryApi {
  caps: {
    all(): Promise<CapabilityMap>;
  };
  schema: {
    kind(): Promise<string>;
    namespaces(): Promise<string[]>;
    tables(): Promise<TableInfo[]>;
    reports(): Promise<ReportInfo[]>;
    collections(): Promise<FileCollectionInfo[]>;
    describeTable(name: string): Promise<TableInfo | null>;
    describeReport(name: string): Promise<ReportInfo | null>;
  };
  raw: {
    document(): Promise<unknown>;
    rows(name: string): Promise<unknown[]>;
  };
  tables: {
    names(): Promise<string[]>;
    get(name: string): Promise<{
      rows(options?: TableQueryOptions): Promise<unknown[]>;
      first(): Promise<unknown | null>;
      count(): Promise<number>;
    }>;
  };
  reports: {
    names(): Promise<string[]>;
    run(name: string, args?: Record<string, unknown>): Promise<unknown>;
  };
  artifacts: {
    list(): Promise<ArtifactRef[]>;
    get(id: string): Promise<ArtifactRef | null>;
    text(id: string): Promise<string>;
    json<T = unknown>(id: string): Promise<T>;
    bytes(id: string): Promise<Uint8Array>;
  };
  files: {
    listCollections(): Promise<FileCollectionInfo[]>;
    materializeArtifact(
      artifactId: string,
      options?: Record<string, unknown>,
    ): Promise<{ kind: "file"; path: string; artifactId: string; bytes?: number; leaseId: string }>;
    exportCollection(
      collectionId: string,
      options?: Record<string, unknown>,
    ): Promise<{
      kind: "directory";
      path: string;
      manifestPath: string;
      collectionId: string;
      fileCount: number;
      leaseId: string;
    }>;
  };
  workspace: {
    root(): Promise<string>;
    allocScratchDir(purpose: string): Promise<{ path: string; leaseId: string }>;
  };
  layers: {
    status(): Promise<Array<{ key: string; status: string; buildMs?: number; lastAccessedAt?: string }>>;
  };
  ns: Record<string, unknown>;
}

export interface DatasetSession {
  manifest: DatasetManifest;
  memorySizeMB: number;
  alias?: string;
  layers: {
    register<T>(spec: LayerSpec<T>): void;
    get<T>(key: string, signal?: AbortSignal): Promise<T>;
    status(): Array<{ key: string; status: string; buildMs?: number; lastAccessedAt?: string }>;
  };
  setId(id: string): void;
  getCapabilityMap(): Promise<CapabilityMap>;
  listTables(): TableInfo[];
  getTable(name: string): TableProvider | undefined;
  listReports(): ReportInfo[];
  getReport(name: string): ReportProvider | undefined;
  listCollections(): FileCollectionInfo[];
  rawDocument(): Promise<unknown>;
  rawRows(name: string): Promise<unknown[]>;
  createQueryApi(options?: QueryRuntimeOptions): DatasetQueryApi;
  listArtifacts(): Promise<ArtifactRef[]>;
  getArtifact(id: string): Promise<ArtifactRef | null>;
  readArtifact(id: string): Promise<ArtifactData | null>;
  materializeArtifact(
    artifactId: string,
    options?: Record<string, unknown>,
  ): Promise<{ kind: "file"; path: string; artifactId: string; bytes?: number; leaseId: string }>;
  exportCollection(
    collectionId: string,
    options?: Record<string, unknown>,
  ): Promise<{
    kind: "directory";
    path: string;
    manifestPath: string;
    collectionId: string;
    fileCount: number;
    leaseId: string;
  }>;
  layerStatus(): Promise<Array<{ key: string; status: string; buildMs?: number; lastAccessedAt?: string }>>;
  dispose(): Promise<void>;
}
