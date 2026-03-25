import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { afterEach, describe, expect, it } from "vitest";
import { TraceServerClient } from "../src/cli/client";

const tempDirs: string[] = [];
const childProcesses: Array<ReturnType<typeof spawn>> = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dataset-kernel-e2e-"));
  tempDirs.push(dir);
  return dir;
}

function createTraceFile() {
  const dir = createTempDir();
  const file = join(dir, "trace.json");
  writeFileSync(
    file,
    JSON.stringify({
      metadata: { source: "server-e2e" },
      traceEvents: [
        {
          cat: "devtools.timeline",
          name: "Screenshot",
          ph: "I",
          pid: 1,
          tid: 1,
          ts: 1000,
          args: { snapshot: Buffer.from("hello-screenshot").toString("base64") },
        },
      ],
    }),
  );
  return file;
}

async function waitForHealth(client: TraceServerClient, timeoutMs = 10_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const health = await client.health();
      if (health.status === "ok") return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Server failed to become healthy");
}

function ensureBuilt() {
  const result = spawnSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    stdio: "pipe",
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(`Build failed: ${result.stderr.toString("utf8")}`);
  }
}

afterEach(async () => {
  while (childProcesses.length > 0) {
    const child = childProcesses.pop();
    if (!child) continue;
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("server process e2e", () => {
  it("serves requests over a unix socket with the client", async () => {
    ensureBuilt();
    const dir = createTempDir();
    const socketPath = join(dir, "server.sock");
    const pidFile = join(dir, "server.pid");
    const traceFile = createTraceFile();

    const child = spawn(process.execPath, [join(process.cwd(), "dist/server/index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TRACE_SERVER_SOCKET: socketPath,
        TRACE_SERVER_PID_FILE: pidFile,
      },
      stdio: "ignore",
    });
    childProcesses.push(child);

    const client = new TraceServerClient(socketPath);
    await waitForHealth(client);

    const loaded = await client.loadSession(traceFile, "e2e");
    expect(loaded.kind).toBe("devtools");

    const schema = await client.schema(loaded.sessionId);
    expect(schema.tables.some((table) => table.name === "devtools.dims.screenshots")).toBe(true);

    const query = await client.query(
      loaded.sessionId,
      `const rows = await (await ds.tables.get('devtools.dims.screenshots')).rows(); return rows.length;`,
    );
    expect(query.result).toBe("1");
  });

  it("returns query errors without killing the server", async () => {
    ensureBuilt();
    const dir = createTempDir();
    const socketPath = join(dir, "server.sock");
    const pidFile = join(dir, "server.pid");
    const traceFile = createTraceFile();

    const child = spawn(process.execPath, [join(process.cwd(), "dist/server/index.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TRACE_SERVER_SOCKET: socketPath,
        TRACE_SERVER_PID_FILE: pidFile,
      },
      stdio: "ignore",
    });
    childProcesses.push(child);

    const client = new TraceServerClient(socketPath);
    await waitForHealth(client);

    const loaded = await client.loadSession(traceFile, "e2e-throw");
    await expect(client.query(loaded.sessionId, `throw new Error("test")`)).rejects.toThrow("test");

    const health = await client.health();
    expect(health.status).toBe("ok");

    const query = await client.query(
      loaded.sessionId,
      `const rows = await (await ds.tables.get('devtools.dims.screenshots')).rows(); return rows.length;`,
    );
    expect(query.result).toBe("1");
  });
});
