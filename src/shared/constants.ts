import { homedir } from "os";
import { join } from "path";

export const ADT_DIR = join(homedir(), ".trace-server");
export const SOCKET_PATH = process.env.TRACE_SERVER_SOCKET || join(ADT_DIR, "server.sock");
export const PID_FILE =
  process.env.TRACE_SERVER_PID_FILE ||
  (process.env.TRACE_SERVER_SOCKET
    ? `${process.env.TRACE_SERVER_SOCKET}.pid`
    : join(ADT_DIR, "server.pid"));
export const WORKSPACE_ROOT = join(ADT_DIR, "workspaces");
export const WORKSPACE_LEASE_TTL_MS = Number(
  process.env.TRACE_SERVER_WORKSPACE_TTL_MS || 6 * 60 * 60 * 1000,
);
export const DEFAULT_QUERY_TIMEOUT = 30_000;
export const MAX_RESULT_SIZE = 10 * 1024 * 1024;
