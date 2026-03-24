import { existsSync } from "fs";
import { resolve } from "path";
import { loadSource } from "../loader/index.js";
import { DEFAULT_QUERY_TIMEOUT } from "../shared/constants.js";
import { executeQuery, QueryTimeoutError, serializeResult } from "./query-engine.js";
import { sessionManager } from "./sessions.js";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function readJson(req: Request) {
  const text = await req.text();
  if (!text) return {} as Record<string, any>;
  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new Error("Invalid JSON body");
  }
}

function formatSession(session: ReturnType<typeof sessionManager.get> extends infer T ? Exclude<T, undefined> : never) {
  return {
    ...session.manifest,
    alias: session.alias,
    memorySizeMB: session.memorySizeMB,
  };
}

function handleHealth() {
  return json({
    status: "ok",
    pid: process.pid,
    uptime: process.uptime(),
    sessions: sessionManager.count(),
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  });
}

async function handleLoadSession(req: Request) {
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
    const session = sessionManager.create(await loadSource(resolved), typeof alias === "string" ? alias : undefined);
    return json(
      {
        sessionId: session.manifest.id,
        alias: session.alias,
        kind: session.manifest.kind,
        source: session.manifest.source,
        fileSizeBytes: session.manifest.fileSizeBytes,
        itemCount: session.manifest.itemCount,
        memorySizeMB: session.memorySizeMB,
      },
      201,
    );
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}

async function handleQuery(sessionId: string, req: Request) {
  const session = sessionManager.get(sessionId);
  if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
  let body: Record<string, any>;
  try {
    body = await readJson(req);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const code = body.code;
  const timeout = typeof body.timeout === "number" && Number.isFinite(body.timeout) && body.timeout > 0 ? body.timeout : DEFAULT_QUERY_TIMEOUT;
  if (typeof code !== "string" || code.length === 0) {
    return json({ error: "code is required" }, 400);
  }
  const start = performance.now();
  try {
    const result = await executeQuery(session, code, timeout);
    const serialized = serializeResult(result);
    return json({ result: serialized.serialized, duration: Math.round(performance.now() - start), truncated: serialized.truncated });
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

function handleStop() {
  setTimeout(() => process.exit(0), 100);
  return json({ ok: true, message: "Server stopping..." });
}

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  const method = req.method;

  if (method === "GET" && pathname === "/health") return handleHealth();
  if (method === "POST" && pathname === "/sessions") return handleLoadSession(req);
  if (method === "GET" && pathname === "/sessions") return json({ sessions: sessionManager.list() });
  if (method === "POST" && pathname === "/server/stop") return handleStop();

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (sessionMatch) {
    const session = sessionManager.get(sessionMatch[1]!);
    if (!session) return json({ error: `Session not found: ${sessionMatch[1]}` }, 404);
    if (method === "GET") return json(formatSession(session));
    if (method === "DELETE") {
      sessionManager.unload(sessionMatch[1]!);
      return json({ ok: true, sessionId: sessionMatch[1] });
    }
  }

  const queryMatch = pathname.match(/^\/sessions\/([^/]+)\/query$/);
  if (queryMatch && method === "POST") return handleQuery(queryMatch[1]!, req);

  const capsMatch = pathname.match(/^\/sessions\/([^/]+)\/caps$/);
  if (capsMatch && method === "GET") {
    const session = sessionManager.get(capsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${capsMatch[1]}` }, 404);
    return json({ caps: await session.getCapabilityMap() });
  }

  const schemaMatch = pathname.match(/^\/sessions\/([^/]+)\/schema$/);
  if (schemaMatch && method === "GET") {
    const session = sessionManager.get(schemaMatch[1]!);
    if (!session) return json({ error: `Session not found: ${schemaMatch[1]}` }, 404);
    return json({
      kind: session.manifest.kind,
      namespaces: [...new Set([...session.listTables().map((t) => t.name.split(".")[0] ?? "default"), ...session.listReports().map((r) => r.name.split(".")[0] ?? "default")])].sort(),
      tables: session.listTables(),
      reports: session.listReports(),
      collections: session.listCollections(),
    });
  }

  const tablesMatch = pathname.match(/^\/sessions\/([^/]+)\/tables$/);
  if (tablesMatch && method === "GET") {
    const session = sessionManager.get(tablesMatch[1]!);
    if (!session) return json({ error: `Session not found: ${tablesMatch[1]}` }, 404);
    return json({ tables: session.listTables() });
  }

  const tableQueryMatch = pathname.match(/^\/sessions\/([^/]+)\/tables\/([^/]+)\/query$/);
  if (tableQueryMatch && method === "POST") {
    const [, sessionId, tableName] = tableQueryMatch;
    const session = sessionManager.get(sessionId!);
    if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
    const table = session.getTable(decodeURIComponent(tableName!));
    if (!table) return json({ error: `Table not found: ${tableName}` }, 404);
    const body = (await readJson(req).catch(() => ({}))) as Record<string, any>;
    const limit = typeof body.limit === "number" && Number.isFinite(body.limit) && body.limit > 0 ? body.limit : undefined;
    const rows = await table.rows(session, { limit });
    return json({ table: table.name, rows });
  }

  const reportsMatch = pathname.match(/^\/sessions\/([^/]+)\/reports$/);
  if (reportsMatch && method === "GET") {
    const session = sessionManager.get(reportsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${reportsMatch[1]}` }, 404);
    return json({ reports: session.listReports() });
  }

  const reportRunMatch = pathname.match(/^\/sessions\/([^/]+)\/reports\/([^/]+)$/);
  if (reportRunMatch && method === "POST") {
    const [, sessionId, reportName] = reportRunMatch;
    const session = sessionManager.get(sessionId!);
    if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
    const report = session.getReport(decodeURIComponent(reportName!));
    if (!report) return json({ error: `Report not found: ${reportName}` }, 404);
    const body = await readJson(req).catch(() => ({}));
    return json({ report: report.name, result: await report.run(session, body) });
  }

  const artifactsMatch = pathname.match(/^\/sessions\/([^/]+)\/artifacts$/);
  if (artifactsMatch && method === "GET") {
    const session = sessionManager.get(artifactsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${artifactsMatch[1]}` }, 404);
    return json({ artifacts: await session.listArtifacts() });
  }

  const artifactMaterializeMatch = pathname.match(/^\/sessions\/([^/]+)\/artifacts\/(.+)\/materialize$/);
  if (artifactMaterializeMatch && method === "POST") {
    const session = sessionManager.get(artifactMaterializeMatch[1]!);
    if (!session) return json({ error: `Session not found: ${artifactMaterializeMatch[1]}` }, 404);
    const artifactId = decodeURIComponent(artifactMaterializeMatch[2]!);
    const body = await readJson(req).catch(() => ({}));
    return json(await session.materializeArtifact(artifactId, body));
  }

  const collectionsMatch = pathname.match(/^\/sessions\/([^/]+)\/files\/collections$/);
  if (collectionsMatch && method === "GET") {
    const session = sessionManager.get(collectionsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${collectionsMatch[1]}` }, 404);
    return json({ collections: session.listCollections() });
  }

  const collectionExportMatch = pathname.match(/^\/sessions\/([^/]+)\/files\/collections\/([^/]+)\/export$/);
  if (collectionExportMatch && method === "POST") {
    const [, sessionId, collectionId] = collectionExportMatch;
    const session = sessionManager.get(sessionId!);
    if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
    const body = await readJson(req).catch(() => ({}));
    return json(await session.exportCollection(decodeURIComponent(collectionId!), body));
  }

  return json({ error: "Not found" }, 404);
}
