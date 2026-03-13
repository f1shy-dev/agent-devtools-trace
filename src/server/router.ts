import { existsSync } from "fs";
import { resolve } from "path";
import { loadTrace } from "../loader";
import { DEFAULT_QUERY_TIMEOUT, MAX_RESULT_SIZE } from "../shared/constants";
import { executeQuery } from "./query-engine";
import { sessionManager } from "./sessions";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, any>> {
  try {
    return (await req.json()) as Record<string, any>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function serializeResult(result: unknown): { value: unknown; truncated: boolean } {
  let serialized: string;
  try {
    serialized = JSON.stringify(result);
  } catch {
    serialized = JSON.stringify(String(result));
  }

  if (typeof serialized !== "string") {
    serialized = "null";
  }

  if (Buffer.byteLength(serialized) > MAX_RESULT_SIZE) {
    return {
      value: `${serialized.slice(0, MAX_RESULT_SIZE)}...<truncated>`,
      truncated: true,
    };
  }

  return {
    value: JSON.parse(serialized),
    truncated: false,
  };
}

function formatSession(
  session: ReturnType<typeof sessionManager.get> extends infer T ? Exclude<T, undefined> : never,
) {
  return {
    id: session.id,
    file: session.file,
    alias: session.alias,
    events: session.trace.traceEvents.length,
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
    const trace = await loadTrace(resolved);
    const session = sessionManager.create(
      resolved,
      trace,
      typeof alias === "string" ? alias : undefined,
    );
    return json(
      {
        sessionId: session.id,
        file: session.file,
        alias: session.alias,
        events: session.trace.traceEvents.length,
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
  const timeout = typeof body.timeout === "number" ? body.timeout : DEFAULT_QUERY_TIMEOUT;
  if (typeof code !== "string" || code.length === 0) {
    return json({ error: "code is required" }, 400);
  }

  const start = performance.now();
  try {
    const result = await executeQuery(session, code, timeout);
    const duration = Math.round(performance.now() - start);
    const serialized = serializeResult(result);
    return json({
      result: serialized.value,
      duration,
      truncated: serialized.truncated,
    });
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : String(error),
        duration: Math.round(performance.now() - start),
      },
      400,
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

  const queryMatch = pathname.match(/^\/sessions\/([^/]+)\/query$/);
  if (queryMatch && method === "POST") {
    return handleQuery(queryMatch[1], req);
  }

  if (method === "POST" && pathname === "/server/stop") {
    return handleStop();
  }

  return json({ error: "Not found" }, 404);
}
