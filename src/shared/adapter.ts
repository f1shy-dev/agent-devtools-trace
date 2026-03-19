import type { Session } from "./types";

export interface EndpointContext {
  session: Session;
  method: string;
  searchParams: URLSearchParams;
  subpath?: string;
  readBody: () => Promise<Record<string, any>>;
}

export type EndpointResult = unknown | Response;

export type EndpointHandler = (ctx: EndpointContext) => Promise<EndpointResult>;

export interface TraceAdapter<TData = any> {
  readonly type: string;
  canLoad(filePath: string): boolean;
  load(filePath: string): Promise<TData>;
  getItemCount(data: TData): number;
  getEndpoints(): Map<string, EndpointHandler>;
  buildQueryContext(data: TData, options?: Record<string, string>): Record<string, unknown>;
}
