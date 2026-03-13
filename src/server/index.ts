import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { ADT_DIR, PID_FILE, SOCKET_PATH } from "../shared/constants";
import type { ServerInfo } from "../shared/types";
import { handleRequest } from "./router";

mkdirSync(ADT_DIR, { recursive: true });

if (existsSync(SOCKET_PATH)) {
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}
}

const server = Bun.serve({
  unix: SOCKET_PATH,
  fetch: handleRequest,
});

const serverInfo: ServerInfo = {
  pid: process.pid,
  socketPath: SOCKET_PATH,
  startedAt: new Date().toISOString(),
};
writeFileSync(PID_FILE, JSON.stringify(serverInfo));

console.log(`trace-server running on ${SOCKET_PATH} (PID: ${process.pid})`);

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  server.stop();
  try {
    unlinkSync(SOCKET_PATH);
  } catch {}
  try {
    unlinkSync(PID_FILE);
  } catch {}
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
