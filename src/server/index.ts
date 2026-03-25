import { createServer } from "http";
import { Readable } from "stream";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { ADT_DIR, PID_FILE, SOCKET_PATH } from "../shared/constants.js";
import type { ServerInfo } from "../shared/types.js";
import { handleRequest } from "./router.js";

mkdirSync(ADT_DIR, { recursive: true });
mkdirSync(dirname(SOCKET_PATH), { recursive: true });
mkdirSync(dirname(PID_FILE), { recursive: true });

if (existsSync(SOCKET_PATH)) {
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}
}

function toRequest(req: import("http").IncomingMessage) {
  const protocol = "http:";
  const host = req.headers.host ?? "localhost";
  const url = `${protocol}//${host}${req.url ?? "/"}`;
  const body =
    req.method === "GET" || req.method === "HEAD"
      ? undefined
      : (Readable.toWeb(req) as unknown as ReadableStream);
  return new Request(url, {
    method: req.method,
    headers: new Headers(
      Object.entries(req.headers).flatMap(([key, value]) => {
        if (Array.isArray(value)) return value.map((item) => [key, item] as [string, string]);
        return value ? ([[key, value]] as [string, string][]) : [];
      }),
    ),
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

const server = createServer(async (req, res) => {
  try {
    const response = await handleRequest(toRequest(req));
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    const buffer = Buffer.from(await response.arrayBuffer());
    res.end(buffer);
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(SOCKET_PATH);

const serverInfo: ServerInfo = {
  pid: process.pid,
  socketPath: SOCKET_PATH,
  startedAt: new Date().toISOString(),
};
writeFileSync(PID_FILE, JSON.stringify(serverInfo));
console.log(`trace-server running on ${SOCKET_PATH} (PID: ${process.pid})`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => {
    rmSync(SOCKET_PATH, { force: true });
    rmSync(PID_FILE, { force: true });
    process.exit(0);
  });
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});
