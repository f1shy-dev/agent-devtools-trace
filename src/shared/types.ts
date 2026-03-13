export interface TraceEvent {
  cat: string;
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  tdur?: number;
  tts?: number;
  args?: Record<string, any>;
  id?: string;
  s?: string;
}

export interface TraceMetadata {
  enhancedTraceVersion?: number;
  source?: string;
  startTime?: string;
  dataOrigin?: string;
  hostDPR?: number;
  sourceMaps?: any[];
  modifications?: any;
  [key: string]: any;
}

export interface ParsedTrace {
  metadata: TraceMetadata;
  traceEvents: TraceEvent[];
}

export interface TraceIndexes {
  byCategory: Map<string, TraceEvent[]>;
  byName: Map<string, TraceEvent[]>;
  byThread: Map<string, TraceEvent[]>;
  byPhase: Map<string, TraceEvent[]>;
}

export interface Session {
  id: string;
  file: string;
  alias?: string;
  trace: ParsedTrace;
  indexes: TraceIndexes;
  loadedAt: Date;
  fileSizeBytes: number;
  memorySizeMB: number;
}

export interface ServerInfo {
  pid: number;
  socketPath: string;
  startedAt: string;
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
  file: string;
  alias?: string;
  events: number;
  memorySizeMB: number;
}

export interface SessionInfo {
  id: string;
  file: string;
  alias?: string;
  events: number;
  loadedAt: string;
  fileSizeBytes: number;
  memorySizeMB: number;
}

export interface QueryResponse {
  result: string;
  duration: number;
  truncated: boolean;
}

export interface CategoryInfo {
  category: string;
  count: number;
  percentage: number;
  phases: Record<string, number>;
  topNames: string[];
}

export interface ThreadInfo {
  pid: number;
  tid: number;
  threadKey: string;
  name?: string;
  processName?: string;
  eventCount: number;
  categories: string[];
}

export interface NetworkRequest {
  requestId: string;
  url: string;
  method: string;
  resourceType?: string;
  priority?: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  statusCode?: number;
  mimeType?: string;
  encodedDataLength?: number;
  decodedBodyLength?: number;
  fromCache?: boolean;
  initiator?: { type: string; url?: string };
}

export interface LongTask {
  name: string;
  category: string;
  durationMs: number;
  startTimeMs: number;
  pid: number;
  tid: number;
  threadName?: string;
}

export interface ScreenshotInfo {
  index: number;
  timestamp: number;
  timestampMs: number;
  sizeBytes: number;
  base64Length: number;
}

export interface SummaryResponse {
  file: string;
  totalEvents: number;
  durationMs: number;
  startTime?: string;
  categories: number;
  threads: number;
  processes: number;
  phases: Record<string, number>;
  topCategories: { category: string; count: number; pct: number }[];
  topEventNames: { name: string; count: number }[];
  hasScreenshots: boolean;
  screenshotCount: number;
  hasNetworkEvents: boolean;
  networkRequestCount: number;
  hasSourceMaps: boolean;
  sourceMapCount: number;
  memorySizeMB: number;
}

export interface CategoriesResponse {
  categories: CategoryInfo[];
}

export interface ThreadsResponse {
  threads: ThreadInfo[];
}

export interface NetworkResponse {
  requests: NetworkRequest[];
}

export interface LongTasksResponse {
  thresholdMs: number;
  tasks: LongTask[];
}

export interface ScreenshotsResponse {
  screenshots: ScreenshotInfo[];
}

export interface ExtractScreenshotsResponse {
  dir: string;
  count: number;
  files: string[];
}

export interface StopServerResponse {
  ok: true;
  message: string;
}
