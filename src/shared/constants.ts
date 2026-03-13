import { homedir } from "os";
import { join } from "path";

export const ADT_DIR = join(homedir(), ".trace-server");
export const SOCKET_PATH = join(ADT_DIR, "server.sock");
export const PID_FILE = join(ADT_DIR, "server.pid");
export const DEFAULT_QUERY_TIMEOUT = 30000;
export const MAX_RESULT_SIZE = 10 * 1024 * 1024;
