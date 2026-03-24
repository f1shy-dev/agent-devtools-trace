import { existsSync, mkdirSync, readFileSync, unlinkSync } from "fs";
import { spawn } from "child_process";
import { ADT_DIR, PID_FILE, SOCKET_PATH } from "../shared/constants.js";
import type { ServerInfo } from "../shared/types.js";
import { TraceServerClient } from "./client.js";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cleanupStaleFiles() {
  for (const path of [SOCKET_PATH, PID_FILE]) {
    if (!existsSync(path)) continue;
    try {
      unlinkSync(path);
    } catch {}
  }
}

export async function isServerRunning() {
  if (!existsSync(PID_FILE)) return false;
  try {
    const info = JSON.parse(readFileSync(PID_FILE, "utf8")) as ServerInfo;
    process.kill(info.pid, 0);
    const client = new TraceServerClient(SOCKET_PATH);
    const response = await client.health();
    return response.status === "ok";
  } catch {
    return false;
  }
}

export async function ensureServer() {
  if (await isServerRunning()) return;
  cleanupStaleFiles();
  mkdirSync(ADT_DIR, { recursive: true });

  const distServer = new URL("../../dist/server/index.js", import.meta.url);
  let child;
  if (existsSync(distServer)) {
    child = spawn(process.execPath, [distServer.pathname], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
  } else {
    child = spawn("bun", ["run", "src/server/index.ts"], {
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
  }
  child.unref();

  const started = Date.now();
  while (Date.now() - started < 10_000) {
    await sleep(200);
    if (await isServerRunning()) return;
  }
  throw new Error("Server failed to start within 10s");
}
