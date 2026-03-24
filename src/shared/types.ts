export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ServerInfo {
  pid: number;
  socketPath: string;
  startedAt: string;
}

export interface DatasetManifest {
  id: string;
  kind: string;
  driverId: string;
  source: string;
  loadedAt: string;
  fileSizeBytes: number;
  itemCount?: number;
}

export interface SessionInfo extends DatasetManifest {
  alias?: string;
  memorySizeMB: number;
}

export interface HealthResponse {
  status: "ok";
  pid: number;
  uptime: number;
  sessions: number;
  memoryMB: number;
}

export interface LoadedSessionResponse {
  sessionId: string;
  alias?: string;
  kind: string;
  source: string;
  fileSizeBytes: number;
  itemCount?: number;
  memorySizeMB: number;
}

export interface QueryResponse {
  result: string;
  duration: number;
  truncated: boolean;
}

export interface CapabilityMap {
  [key: string]: string | number | boolean | null;
}

export interface TableColumn {
  name: string;
  type: string;
  description?: string;
  unit?: string;
}

export interface TableInfo {
  name: string;
  description: string;
  columns: TableColumn[];
}

export interface ReportInfo {
  name: string;
  description: string;
}

export interface ArtifactRef {
  id: string;
  kind: "text" | "json" | "image" | "binary";
  mediaType: string;
  sizeBytes?: number;
  filenameHint?: string;
  hash?: string;
  metadata?: Record<string, unknown>;
}

export interface FileCollectionInfo {
  id: string;
  description: string;
}

export interface SchemaResponse {
  kind: string;
  namespaces: string[];
  tables: TableInfo[];
  reports: ReportInfo[];
  collections: FileCollectionInfo[];
}

export interface MaterializedFile {
  kind: "file";
  path: string;
  artifactId: string;
  bytes?: number;
  leaseId: string;
}

export interface MaterializedDirectory {
  kind: "directory";
  path: string;
  manifestPath: string;
  collectionId: string;
  fileCount: number;
  leaseId: string;
}

export interface LeaseInfo {
  leaseId: string;
  kind: "scratch" | "export";
  purpose: string;
  path: string;
  createdAt: string;
  pinned: boolean;
  status: "active" | "released";
  bytes?: number;
  expiresAt?: string;
}

export interface LayerStatusInfo {
  key: string;
  status: string;
  buildMs?: number;
  lastAccessedAt?: string;
  sizeBytes?: number;
  deps?: string[];
  evictable: boolean;
  pinned: boolean;
}

export interface TableRowsResponse {
  table: string;
  rows?: unknown[];
  rendered?: string;
}

export interface ReportResponse {
  report: string;
  result?: unknown;
  rendered?: string;
}

export interface StopServerResponse {
  ok: true;
  message: string;
}
