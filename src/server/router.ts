import { existsSync } from "fs";
import { resolve } from "path";
import { loadTrace } from "../loader";
import { DEFAULT_QUERY_TIMEOUT } from "../shared/constants";
import { executeQuery, QueryTimeoutError, serializeResult } from "./query-engine";
import { sessionManager } from "./sessions";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, any>> {
  const text = await req.text();
  if (text.length === 0) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function formatSession(
  session: ReturnType<typeof sessionManager.get> extends infer T ? Exclude<T, undefined> : never,
) {
  return {
    id: session.id,
    file: session.file,
    alias: session.alias,
    type: session.type,
    events: session.adapter.getItemCount(session.data),
    loadedAt: session.loadedAt.toISOString(),
    fileSizeBytes: session.fileSizeBytes,
    memorySizeMB: session.memorySizeMB,
  };
}

function handleHealth(): Response {
  return json({
    status: "ok",
    pid: process.pid,
    uptime: process.uptime(),
    sessions: sessionManager.count(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}

async function handleLoadSession(req: Request): Promise<Response> {
  let body: Record<string, any>;
  try {
    body = await readJson(req);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  const file = body.file;
  const alias = body.alias;
  if (typeof file !== "string" || file.length === 0) {
    return json({ error: "file is required" }, 400);
  }

  const resolved = resolve(file);
  if (!existsSync(resolved)) {
    return json({ error: `File not found: ${resolved}` }, 404);
  }

  try {
    const { adapter, data } = await loadTrace(resolved);
    const session = sessionManager.create(
      resolved,
      adapter,
      data,
      typeof alias === "string" ? alias : undefined,
    );
    return json(
      {
        sessionId: session.id,
        file: session.file,
        alias: session.alias,
        type: session.type,
        events: session.adapter.getItemCount(session.data),
        memorySizeMB: session.memorySizeMB,
      },
      201,
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

function handleListSessions(): Response {
  return json({
    sessions: sessionManager.list().map((session) => formatSession(session)),
  });
}

function handleGetSession(id: string): Response {
  const session = sessionManager.get(id);
  if (!session) {
    return json({ error: `Session not found: ${id}` }, 404);
  }

  return json(formatSession(session));
}

function handleDeleteSession(id: string): Response {
  if (!sessionManager.unload(id)) {
    return json({ error: `Session not found: ${id}` }, 404);
  }

  return json({ ok: true, sessionId: id });
}

async function handleQuery(sessionId: string, req: Request): Promise<Response> {
  const session = sessionManager.get(sessionId);
  if (!session) {
    return json({ error: `Session not found: ${sessionId}` }, 404);
  }

  let body: Record<string, any>;
  try {
    body = await readJson(req);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }

  const code = body.code;
  const timeout =
    typeof body.timeout === "number" && Number.isFinite(body.timeout) && body.timeout > 0
      ? body.timeout
      : DEFAULT_QUERY_TIMEOUT;
  if (typeof code !== "string" || code.length === 0) {
    return json({ error: "code is required" }, 400);
  }

  const queryOptions: Record<string, string> = {};
  if (typeof body.route === "string") {
    queryOptions.route = body.route;
  }

  const start = performance.now();
  try {
    const result = await executeQuery(session, code, timeout, queryOptions);
    const duration = Math.round(performance.now() - start);
    const serialized = serializeResult(result);
    return json({
      result: serialized.serialized,
      duration,
      truncated: serialized.truncated,
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
        duration: Math.round(performance.now() - start),
      },
      error instanceof QueryTimeoutError ? 408 : 400,
    );
  }
}

function handleStop(): Response {
  setTimeout(() => process.exit(0), 100);
  return json({ ok: true, message: "Server stopping..." });
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/health") {
    return handleHealth();
  }
  if (method === "POST" && pathname === "/sessions") {
    return handleLoadSession(req);
  }
  if (method === "GET" && pathname === "/sessions") {
    return handleListSessions();
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const id = sessionMatch[1];
    if (method === "GET") {
      return handleGetSession(id);
    }
    if (method === "DELETE") {
      return handleDeleteSession(id);
    }
  }

  const heuristicMatch = pathname.match(/^\/sessions\/([^/]+)\/(\w[\w-]*)(?:\/(.+))?$/);
  if (heuristicMatch && (method === "GET" || method === "POST")) {
    const [, id, endpoint, subpath] = heuristicMatch;
    if (endpoint === "query") {
      if (method === "POST") {
        return handleQuery(id, req);
      }
    } else {
      const session = sessionManager.get(id);
      if (!session) {
        return json({ error: `Session not found: ${id}` }, 404);
      }

      const endpoints = session.adapter.getEndpoints();
      const handler = endpoints.get(endpoint);
      if (!handler) {
        return json({ error: `Endpoint '${endpoint}' is not available for '${session.type}' sessions` }, 404);
      }

      try {
        const result = await handler({
          session,
          method,
          searchParams: url.searchParams,
          subpath,
          readBody: () => readJson(req),
        });
        if (result instanceof Response) {
          return result;
        }
        return json(result);
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
      }
    }
  }

  if (method === "POST" && pathname === "/server/stop") {
    return handleStop();
  }

  return json({ error: "Not found" }, 404);
}
