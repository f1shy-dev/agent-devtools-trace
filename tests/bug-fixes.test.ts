import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadSource } from "../src/loader/index";
import { handleRequest } from "../src/server/router";
import { SessionManager, sessionManager } from "../src/server/sessions";

const tempDirs: string[] = [];
let cliBuilt = false;

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "trace-server-bug-fixes-"));
  tempDirs.push(dir);
  return dir;
}

function createTraceFile(name = "trace.json", metadataSource = "bug-fixes") {
  const dir = createTempDir();
  const file = join(dir, name);
  writeFileSync(
    file,
    JSON.stringify({
      metadata: { source: metadataSource },
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

async function parseJson(response: Response) {
  return (await response.json()) as Record<string, any>;
}

function ensureBuilt() {
  if (cliBuilt) return;
  const result = spawnSync("npm", ["run", "build"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "Build failed");
  }
  cliBuilt = true;
}

afterEach(() => {
  sessionManager.clear();
  vi.resetModules();
  vi.doUnmock("../src/core/io.js");
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("bug fixes", () => {
  it("rejects invalid aliases in SessionManager.create()", async () => {
    const file = createTraceFile();
    const manager = new SessionManager();
    const session = await loadSource(file);

    expect(() => manager.create(session, "test/bad")).toThrow(
      "Invalid alias 'test/bad': must be 1-64 alphanumeric characters, dots, hyphens, or underscores, starting with alphanumeric",
    );
  });

  it("returns 400 for invalid aliases on the load endpoint", async () => {
    const file = createTraceFile();
    const response = await handleRequest(
      new Request("http://trace-server/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file, alias: "test/bad" }),
      }),
    );

    expect(response.status).toBe(400);
    expect(await parseJson(response)).toEqual({
      error: "Invalid alias: must be 1-64 alphanumeric characters, dots, hyphens, or underscores",
    });
  });

  it("rejects duplicate aliases instead of loading both sessions", async () => {
    const firstFile = createTraceFile("first.json", "first");
    const secondFile = createTraceFile("second.json", "second");

    const first = await handleRequest(
      new Request("http://trace-server/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: firstFile, alias: "duplicate" }),
      }),
    );
    expect(first.status).toBe(201);

    const second = await handleRequest(
      new Request("http://trace-server/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: secondFile, alias: "duplicate" }),
      }),
    );
    expect(second.status).toBe(400);

    const payload = await parseJson(second);
    expect(payload.error).toContain("Alias 'duplicate' is already in use by session");
  });

  it("reports missing query files before any server error", () => {
    ensureBuilt();
    const missingFile = join(createTempDir(), "missing.js");
    const result = spawnSync(
      process.execPath,
      [join(process.cwd(), "dist/cli/index.js"), "query", "missing-session", "--file", missingFile],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env },
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Error: File not found: ${missingFile}`);
    expect(result.stderr).not.toContain("Server is not running");
  });

  it("reports driver-specific detection failures for oversized or memory-failing gzip reads", async () => {
    vi.resetModules();
    vi.doMock("../src/drivers/devtools.js", () => ({
      DevtoolsDriver: class {
        id = "devtools";

        async detect() {
          throw new RangeError("heap out of memory");
        }
      },
    }));
    vi.doMock("../src/drivers/raw-json.js", () => ({
      RawJsonDriver: class {
        id = "raw-json";

        async detect() {
          throw new RangeError("heap out of memory");
        }
      },
    }));

    const { loadSource: mockedLoadSource } = await import("../src/loader/index.js");
    const file = createTraceFile("Trace-20260313T190841.json.gz");

    await expect(mockedLoadSource(file)).rejects.toThrow(
      `Failed to load ${file}:\n  devtools: heap out of memory\n  raw-json: heap out of memory`,
    );
  });
});
