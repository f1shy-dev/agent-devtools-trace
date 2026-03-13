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
