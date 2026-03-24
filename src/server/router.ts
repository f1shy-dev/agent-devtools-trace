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

function formatSession(
  session: ReturnType<typeof sessionManager.get> extends infer T ? Exclude<T, undefined> : never,
) {
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
    const session = sessionManager.create(
      await loadSource(resolved),
      typeof alias === "string" ? alias : undefined,
    );
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
  const timeout =
    typeof body.timeout === "number" && Number.isFinite(body.timeout) && body.timeout > 0
      ? body.timeout
      : DEFAULT_QUERY_TIMEOUT;
  if (typeof code !== "string" || code.length === 0) {
    return json({ error: "code is required" }, 400);
  }
  const start = performance.now();
  try {
    const result = await executeQuery(session, code, timeout);
    const serialized = serializeResult(result);
    return json({
      result: serialized.serialized,
      duration: Math.round(performance.now() - start),
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
  if (method === "GET" && pathname === "/sessions")
    return json({ sessions: sessionManager.list() });
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
      namespaces: [
        ...new Set([
          ...session.listTables().map((t) => t.name.split(".")[0] ?? "default"),
          ...session.listReports().map((r) => r.name.split(".")[0] ?? "default"),
        ]),
      ].sort(),
      tables: session.listTables(),
      reports: session.listReports(),
      collections: session.listCollections(),
    });
  }

  const schemaPathsMatch = pathname.match(/^\/sessions\/([^/]+)\/schema\/paths$/);
  if (schemaPathsMatch && method === "GET") {
    const session = sessionManager.get(schemaPathsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${schemaPathsMatch[1]}` }, 404);
    return json({ paths: await session.schemaPaths() });
  }

  const schemaSamplesMatch = pathname.match(/^\/sessions\/([^/]+)\/schema\/samples$/);
  if (schemaSamplesMatch && method === "GET") {
    const session = sessionManager.get(schemaSamplesMatch[1]!);
    if (!session) return json({ error: `Session not found: ${schemaSamplesMatch[1]}` }, 404);
    const requestedPath = url.searchParams.get("path");
    if (!requestedPath) return json({ error: "path is required" }, 400);
    return json({ path: requestedPath, samples: await session.schemaSamples(requestedPath) });
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
    const decodedName = decodeURIComponent(tableName!);
    const table = session.getTable(decodedName);
    if (!table) return json({ error: `Table not found: ${tableName}` }, 404);
    const body = (await readJson(req).catch(() => ({}))) as Record<string, any>;
    if (body.format === "table") {
      const rendered = await session.prettyTable(decodedName, body, {
        mode: "table",
        maxRows: typeof body.maxRows === "number" ? body.maxRows : undefined,
      });
      return json({ table: table.name, rendered });
    }
    if (body.format === "pretty") {
      const rendered = await session.prettyTable(decodedName, body, {
        maxRows: typeof body.maxRows === "number" ? body.maxRows : undefined,
      });
      return json({ table: table.name, rendered });
    }
    const rows = await session.queryTable(decodedName, body);
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
    const decodedName = decodeURIComponent(reportName!);
    const report = session.getReport(decodedName);
    if (!report) return json({ error: `Report not found: ${reportName}` }, 404);
    const body = (await readJson(req).catch(() => ({}))) as Record<string, any>;
    const { format, ...reportArgs } = body;
    if (format === "pretty") {
      const rendered = await session.prettyReport(decodedName, reportArgs);
      return json({ report: report.name, rendered });
    }
    const result = await report.run(session, reportArgs);
    return json({ report: report.name, result });
  }

  const artifactsMatch = pathname.match(/^\/sessions\/([^/]+)\/artifacts$/);
  if (artifactsMatch && method === "GET") {
    const session = sessionManager.get(artifactsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${artifactsMatch[1]}` }, 404);
    return json({ artifacts: await session.listArtifacts() });
  }

  const artifactGetMatch = pathname.match(/^\/sessions\/([^/]+)\/artifacts\/(.+)$/);
  if (
    artifactGetMatch &&
    method === "GET" &&
    !pathname.endsWith("/content") &&
    !pathname.endsWith("/materialize")
  ) {
    const session = sessionManager.get(artifactGetMatch[1]!);
    if (!session) return json({ error: `Session not found: ${artifactGetMatch[1]}` }, 404);
    const artifact = await session.getArtifact(decodeURIComponent(artifactGetMatch[2]!));
    if (!artifact) return json({ error: `Artifact not found: ${artifactGetMatch[2]}` }, 404);
    return json(artifact);
  }

  const artifactContentMatch = pathname.match(/^\/sessions\/([^/]+)\/artifacts\/(.+)\/content$/);
  if (artifactContentMatch && method === "GET") {
    const session = sessionManager.get(artifactContentMatch[1]!);
    if (!session) return json({ error: `Session not found: ${artifactContentMatch[1]}` }, 404);
    const artifactId = decodeURIComponent(artifactContentMatch[2]!);
    const artifact = await session.getArtifact(artifactId);
    const data = await session.readArtifact(artifactId);
    if (!artifact || !data) return json({ error: `Artifact not found: ${artifactId}` }, 404);
    if (data.kind === "text")
      return new Response(data.text ?? "", { headers: { "Content-Type": artifact.mediaType } });
    if (data.kind === "json")
      return new Response(JSON.stringify(data.json ?? null, null, 2), {
        headers: { "Content-Type": artifact.mediaType },
      });
    return new Response(new Uint8Array(data.bytes ?? new Uint8Array()), {
      headers: { "Content-Type": artifact.mediaType },
    });
  }

  const artifactMaterializeMatch = pathname.match(
    /^\/sessions\/([^/]+)\/artifacts\/(.+)\/materialize$/,
  );
  if (artifactMaterializeMatch && method === "POST") {
    const session = sessionManager.get(artifactMaterializeMatch[1]!);
    if (!session) return json({ error: `Session not found: ${artifactMaterializeMatch[1]}` }, 404);
    const artifactId = decodeURIComponent(artifactMaterializeMatch[2]!);
    const body = await readJson(req).catch(() => ({}));
    return json(await session.materializeArtifact(artifactId, body));
  }

  const layersMatch = pathname.match(/^\/sessions\/([^/]+)\/layers$/);
  if (layersMatch && method === "GET") {
    const session = sessionManager.get(layersMatch[1]!);
    if (!session) return json({ error: `Session not found: ${layersMatch[1]}` }, 404);
    return json({ layers: await session.layerStatus() });
  }

  const layerPinMatch = pathname.match(/^\/sessions\/([^/]+)\/layers\/([^/]+)\/(pin|unpin|evict)$/);
  if (layerPinMatch && method === "POST") {
    const [, sessionId, layerKey, action] = layerPinMatch;
    const session = sessionManager.get(sessionId!);
    if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
    const decodedKey = decodeURIComponent(layerKey!);
    if (action === "pin") return json({ layer: await session.pinLayer(decodedKey) });
    if (action === "unpin") return json({ layer: await session.unpinLayer(decodedKey) });
    return json(await session.evictLayer(decodedKey));
  }

  const collectionsMatch = pathname.match(/^\/sessions\/([^/]+)\/files\/collections$/);
  if (collectionsMatch && method === "GET") {
    const session = sessionManager.get(collectionsMatch[1]!);
    if (!session) return json({ error: `Session not found: ${collectionsMatch[1]}` }, 404);
    return json({ collections: session.listCollections() });
  }

  const collectionExportMatch = pathname.match(
    /^\/sessions\/([^/]+)\/files\/collections\/([^/]+)\/export$/,
  );
  if (collectionExportMatch && method === "POST") {
    const [, sessionId, collectionId] = collectionExportMatch;
    const session = sessionManager.get(sessionId!);
    if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
    const body = await readJson(req).catch(() => ({}));
    return json(await session.exportCollection(decodeURIComponent(collectionId!), body));
  }

  const leasesMatch = pathname.match(/^\/sessions\/([^/]+)\/files\/leases$/);
  if (leasesMatch && method === "GET") {
    const session = sessionManager.get(leasesMatch[1]!);
    if (!session) return json({ error: `Session not found: ${leasesMatch[1]}` }, 404);
    return json({ leases: await session.listLeases() });
  }

  const leaseActionMatch = pathname.match(
    /^\/sessions\/([^/]+)\/files\/leases\/([^/]+)\/(pin|unpin|release)$/,
  );
  if (leaseActionMatch && method === "POST") {
    const [, sessionId, leaseId, action] = leaseActionMatch;
    const session = sessionManager.get(sessionId!);
    if (!session) return json({ error: `Session not found: ${sessionId}` }, 404);
    const decodedLeaseId = decodeURIComponent(leaseId!);
    if (action === "pin") return json({ lease: await session.pinLease(decodedLeaseId) });
    if (action === "unpin") return json({ lease: await session.unpinLease(decodedLeaseId) });
    return json(await session.releaseLease(decodedLeaseId));
  }

  return json({ error: "Not found" }, 404);
}
