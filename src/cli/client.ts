import http from "node:http";
import { SOCKET_PATH } from "../shared/constants.js";
import type {
  FileCollectionInfo,
  HealthResponse,
  LoadedSessionResponse,
  QueryResponse,
  SchemaResponse,
  SessionInfo,
  StopServerResponse,
  TableInfo,
  ReportInfo,
} from "../shared/types.js";

async function requestUnix<T>(socketPath: string, method: string, path: string, body?: unknown): Promise<T> {
  const payload = body ? JSON.stringify(body) : undefined;
  const headers: Record<string, string> = {};
  if (payload !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload).toString();
  }

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const data = text ? (JSON.parse(text) as Record<string, any>) : {};
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(typeof data.error === "string" ? data.error : `HTTP ${res.statusCode}`));
            return;
          }
          resolve(data as T);
        });
      },
    );

    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export class TraceServerClient {
  private readonly socketPath: string;

  constructor(socketPath = SOCKET_PATH) {
    this.socketPath = socketPath;
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return requestUnix<T>(this.socketPath, method, path, body);
  }

  health() {
    return this.request<HealthResponse>("GET", "/health");
  }

  loadSession(file: string, alias?: string) {
    return this.request<LoadedSessionResponse>("POST", "/sessions", { file, alias });
  }

  async listSessions() {
    const result = await this.request<{ sessions: SessionInfo[] }>("GET", "/sessions");
    return result.sessions;
  }

  getSession(id: string) {
    return this.request<SessionInfo>("GET", `/sessions/${id}`);
  }

  deleteSession(id: string) {
    return this.request<{ ok: boolean; sessionId: string }>("DELETE", `/sessions/${id}`);
  }

  query(id: string, code: string, timeout?: number) {
    const body: Record<string, any> = { code };
    if (timeout) body.timeout = timeout;
    return this.request<QueryResponse>("POST", `/sessions/${id}/query`, body);
  }

  caps(id: string) {
    return this.request<{ caps: Record<string, unknown> }>("GET", `/sessions/${id}/caps`);
  }

  schema(id: string) {
    return this.request<SchemaResponse>("GET", `/sessions/${id}/schema`);
  }

  async tables(id: string) {
    const result = await this.request<{ tables: TableInfo[] }>("GET", `/sessions/${id}/tables`);
    return result.tables;
  }

  table(id: string, table: string, limit?: number) {
    return this.request<{ table: string; rows: unknown[] }>(
      "POST",
      `/sessions/${id}/tables/${encodeURIComponent(table)}/query`,
      limit ? { limit } : {},
    );
  }

  async reports(id: string) {
    const result = await this.request<{ reports: ReportInfo[] }>("GET", `/sessions/${id}/reports`);
    return result.reports;
  }

  report(id: string, report: string, args?: Record<string, unknown>) {
    return this.request<{ report: string; result: unknown }>(
      "POST",
      `/sessions/${id}/reports/${encodeURIComponent(report)}`,
      args ?? {},
    );
  }

  async artifacts(id: string) {
    const result = await this.request<{ artifacts: unknown[] }>("GET", `/sessions/${id}/artifacts`);
    return result.artifacts;
  }

  materializeArtifact(id: string, artifactId: string, options?: Record<string, unknown>) {
    return this.request<any>(
      "POST",
      `/sessions/${id}/artifacts/${encodeURIComponent(artifactId)}/materialize`,
      options ?? {},
    );
  }

  async collections(id: string) {
    const result = await this.request<{ collections: FileCollectionInfo[] }>(
      "GET",
      `/sessions/${id}/files/collections`,
    );
    return result.collections;
  }

  exportCollection(id: string, collectionId: string, options?: Record<string, unknown>) {
    return this.request<any>(
      "POST",
      `/sessions/${id}/files/collections/${encodeURIComponent(collectionId)}/export`,
      options ?? {},
    );
  }

  stopServer() {
    return this.request<StopServerResponse>("POST", "/server/stop");
  }
}
