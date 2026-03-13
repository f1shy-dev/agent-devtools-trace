import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { ADT_DIR, PID_FILE, SOCKET_PATH } from "../shared/constants";
import type { ServerInfo } from "../shared/types";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupStaleFiles() {
  for (const path of [SOCKET_PATH, PID_FILE]) {
    if (!existsSync(path)) {
      continue;
    }

    try {
      unlinkSync(path);
    } catch {}
  }
}

/** Check if server is running and healthy */
export async function isServerRunning(): Promise<boolean> {
  if (!existsSync(PID_FILE)) {
    return false;
  }

  try {
    const info = JSON.parse(readFileSync(PID_FILE, "utf-8")) as ServerInfo;
    process.kill(info.pid, 0);

    const options = {
      unix: SOCKET_PATH,
    } as RequestInit & { unix: string };
    const response = await fetch("http://localhost/health", options);
    return response.ok;
  } catch {
    return false;
  }
}

/** Ensure server is running, spawn if needed */
export async function ensureServer(): Promise<void> {
  if (await isServerRunning()) {
    return;
  }

  cleanupStaleFiles();
  mkdirSync(ADT_DIR, { recursive: true });

  const serverScript = new URL("../server/index.ts", import.meta.url).pathname;
  const child = spawn("bun", ["run", serverScript], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const maxWait = 10_000;
  const start = Date.now();
  while (Date.now() - start < maxWait) {
    await sleep(200);
    if (await isServerRunning()) {
      return;
    }
  }

  throw new Error("Server failed to start within 10s");
}

/** Read server info from PID file */
export function getServerInfo(): ServerInfo | null {
  if (!existsSync(PID_FILE)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(PID_FILE, "utf-8")) as ServerInfo;
  } catch {
    return null;
  }
}
