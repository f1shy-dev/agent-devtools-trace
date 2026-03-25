import type {
  ArtifactRef,
  CapabilityMap,
  DatasetManifest,
  FileCollectionInfo,
  JsonValue,
  LayerStatusInfo,
  LeaseInfo,
  MaterializedDirectory,
  MaterializedFile,
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

export type TableFilterOp =
  | "="
  | "!="
  | "in"
  | "contains"
  | "startsWith"
  | "endsWith"
  | ">"
  | ">="
  | "<"
  | "<="
  | "between";

export interface TableFilter {
  column: string;
  op: TableFilterOp;
  value?: unknown;
  values?: unknown[];
  lower?: unknown;
  upper?: unknown;
}

export interface TableSort {
  column: string;
  direction?: "asc" | "desc";
}

export interface TableQueryPlan {
  select?: string[];
  where?: TableFilter[];
  orderBy?: TableSort[];
  offset?: number;
  limit?: number;
}

export interface TableQueryOptions extends TableQueryPlan {
  limit?: number;
}

export interface PrettyOptions {
  maxRows?: number;
  mode?: "auto" | "table";
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
  evictable?: boolean;
  build(ctx: LayerContext): Promise<T>;
}

export interface TableProvider {
  name: string;
  description: string;
  columns: TableColumn[];
  rows(session: DatasetSession, options?: TableQueryOptions): Promise<unknown[]>;
  query?(session: DatasetSession, plan?: TableQueryPlan): Promise<unknown[]>;
  count?(session: DatasetSession, plan?: TableQueryPlan): Promise<number>;
  pretty?(session: DatasetSession, plan?: TableQueryPlan): Promise<string>;
}

export interface ReportProvider {
  name: string;
  description: string;
  run(session: DatasetSession, args?: Record<string, unknown>): Promise<unknown>;
  pretty?(session: DatasetSession, args?: Record<string, unknown>): Promise<string>;
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

export interface TableQueryHandle {
  rows(plan?: TableQueryPlan): Promise<unknown[]>;
  first(): Promise<unknown | null>;
  count(): Promise<number>;
  query(plan: TableQueryPlan): TableQueryHandle;
  select(columns: string[]): TableQueryHandle;
  where(filter: TableFilter): TableQueryHandle;
  where(column: string, op: TableFilterOp, value: unknown): TableQueryHandle;
  orderBy(column: string, direction?: "asc" | "desc"): TableQueryHandle;
  limit(limit: number): TableQueryHandle;
  offset(offset: number): TableQueryHandle;
  pretty(options?: PrettyOptions): Promise<string>;
  table(options?: PrettyOptions): Promise<string>;
  plan(): TableQueryPlan;
}

export interface ReportQueryHandle {
  args(args: Record<string, unknown>): ReportQueryHandle;
  run(args?: Record<string, unknown>): Promise<unknown>;
  pretty(args?: Record<string, unknown>): Promise<string>;
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
    paths(): Promise<
      Array<{
        path: string;
        count: number;
        types: string[];
        samples: Array<string | number | boolean | null>;
      }>
    >;
    samples(path: string): Promise<unknown[]>;
  };
  raw: {
    document(): Promise<unknown>;
    rows(name: string): Promise<unknown[]>;
  };
  tables: {
    names(): Promise<string[]>;
    get(name: string): TableQueryHandle;
  };
  reports: {
    names(): Promise<string[]>;
    run(name: string, args?: Record<string, unknown>): Promise<unknown>;
    get(name: string): ReportQueryHandle;
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
    ): Promise<MaterializedFile>;
    exportCollection(
      collectionId: string,
      options?: Record<string, unknown>,
    ): Promise<MaterializedDirectory>;
    releaseLease(leaseId: string): Promise<{ ok: boolean; leaseId: string }>;
    pinLease(leaseId: string): Promise<LeaseInfo | null>;
    unpinLease(leaseId: string): Promise<LeaseInfo | null>;
    leases(): Promise<LeaseInfo[]>;
  };
  workspace: {
    root(): Promise<string>;
    allocScratchDir(purpose: string): Promise<{ path: string; leaseId: string }>;
    releaseLease(leaseId: string): Promise<{ ok: boolean; leaseId: string }>;
    pinLease(leaseId: string): Promise<LeaseInfo | null>;
    unpinLease(leaseId: string): Promise<LeaseInfo | null>;
    leases(): Promise<LeaseInfo[]>;
  };
  layers: {
    status(): Promise<LayerStatusInfo[]>;
    evict(key: string): Promise<{ ok: boolean; key: string }>;
    pin(key: string): Promise<LayerStatusInfo | null>;
    unpin(key: string): Promise<LayerStatusInfo | null>;
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
    getStored<T>(key: string, signal?: AbortSignal): Promise<T>;
    status(): LayerStatusInfo[];
    evict(key: string): boolean;
    pin(key: string): LayerStatusInfo | null;
    unpin(key: string): LayerStatusInfo | null;
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
  schemaPaths(): Promise<
    Array<{
      path: string;
      count: number;
      types: string[];
      samples: Array<string | number | boolean | null>;
    }>
  >;
  schemaSamples(path: string): Promise<unknown[]>;
  queryTable(name: string, plan?: TableQueryPlan): Promise<unknown[]>;
  countTable(name: string, plan?: TableQueryPlan): Promise<number>;
  prettyTable(name: string, plan?: TableQueryPlan, options?: PrettyOptions): Promise<string>;
  prettyReport(name: string, args?: Record<string, unknown>): Promise<string>;
  createQueryApi(options?: QueryRuntimeOptions): DatasetQueryApi;
  listArtifacts(): Promise<ArtifactRef[]>;
  getArtifact(id: string): Promise<ArtifactRef | null>;
  readArtifact(id: string): Promise<ArtifactData | null>;
  materializeArtifact(
    artifactId: string,
    options?: Record<string, unknown>,
  ): Promise<MaterializedFile>;
  exportCollection(
    collectionId: string,
    options?: Record<string, unknown>,
  ): Promise<MaterializedDirectory>;
  releaseLease(leaseId: string): Promise<{ ok: boolean; leaseId: string }>;
  pinLease(leaseId: string): Promise<LeaseInfo | null>;
  unpinLease(leaseId: string): Promise<LeaseInfo | null>;
  listLeases(): Promise<LeaseInfo[]>;
  layerStatus(): Promise<LayerStatusInfo[]>;
  evictLayer(key: string): Promise<{ ok: boolean; key: string }>;
  pinLayer(key: string): Promise<LayerStatusInfo | null>;
  unpinLayer(key: string): Promise<LayerStatusInfo | null>;
  dispose(): Promise<void>;
}
