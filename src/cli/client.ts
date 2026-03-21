import { SOCKET_PATH } from "../shared/constants";
import type {
  AnalyzeModulesResponse,
  AnalyzeRoutesResponse,
  AnalyzeSizesResponse,
  CategoriesResponse,
  ExtractScreenshotsResponse,
  HealthResponse,
  LongTasksResponse,
  LoadedSessionResponse,
  NextAnalyzeSummaryResponse,
  NetworkResponse,
  QueryResponse,
  ScreenshotsResponse,
  SessionInfo,
  StopServerResponse,
  SummaryResponse,
  ThreadsResponse,
} from "../shared/types";

export class TraceServerClient {
  private readonly socketPath: string;

  constructor(socketPath = SOCKET_PATH) {
    this.socketPath = socketPath;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const options = {
      method,
      unix: this.socketPath,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    } as RequestInit & { unix: string };
    const response = await fetch(`http://localhost${path}`, options);

    if (response.headers.get("content-type")?.startsWith("image/")) {
      return (await response.arrayBuffer()) as T;
    }

    const text = await response.text();
    const data = text ? (JSON.parse(text) as Record<string, any>) : {};
    if (!response.ok) {
      throw new Error(typeof data.error === "string" ? data.error : `HTTP ${response.status}`);
    }
    return data as T;
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

  query(id: string, code: string, timeout?: number, route?: string) {
    const body: Record<string, any> = { code };
    if (timeout) body.timeout = timeout;
    if (route) body.route = route;
    return this.request<QueryResponse>("POST", `/sessions/${id}/query`, body);
  }

  summary(id: string) {
    return this.request<SummaryResponse | NextAnalyzeSummaryResponse>(
      "GET",
      `/sessions/${id}/summary`,
    );
  }

  routes(id: string) {
    return this.request<AnalyzeRoutesResponse>("GET", `/sessions/${id}/routes`);
  }

  modules(id: string, route?: string, limit?: number) {
    const params = new URLSearchParams();
    if (route) params.set("route", route);
    if (limit) params.set("limit", String(limit));
    const query = params.toString();
    return this.request<AnalyzeModulesResponse>(
      "GET",
      `/sessions/${id}/modules${query ? `?${query}` : ""}`,
    );
  }

  sizes(id: string, route?: string) {
    const query = route ? `?route=${encodeURIComponent(route)}` : "";
    return this.request<AnalyzeSizesResponse>("GET", `/sessions/${id}/sizes${query}`);
  }

  async categories(id: string) {
    const result = await this.request<CategoriesResponse>("GET", `/sessions/${id}/categories`);
    return result.categories;
  }

  async threads(id: string) {
    const result = await this.request<ThreadsResponse>("GET", `/sessions/${id}/threads`);
    return result.threads;
  }

  async network(id: string) {
    const result = await this.request<NetworkResponse>("GET", `/sessions/${id}/network`);
    return result.requests;
  }

  longTasks(id: string, threshold?: number) {
    const query = threshold ? `?threshold=${threshold}` : "";
    return this.request<LongTasksResponse>("GET", `/sessions/${id}/long-tasks${query}`);
  }

  async screenshots(id: string) {
    const result = await this.request<ScreenshotsResponse>("GET", `/sessions/${id}/screenshots`);
    return result.screenshots;
  }

  screenshotImage(id: string, index: number) {
    return this.request<ArrayBuffer>("GET", `/sessions/${id}/screenshots/${index}`);
  }

  extractScreenshots(id: string, outputDir?: string) {
    return this.request<ExtractScreenshotsResponse>("POST", `/sessions/${id}/screenshots/extract`, {
      outputDir,
    });
  }

  stopServer() {
    return this.request<StopServerResponse>("POST", "/server/stop");
  }
}
