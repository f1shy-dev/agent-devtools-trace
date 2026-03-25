/**
 * Tests for fixes derived from the transcript analysis:
 *
 * 1. --file flag on query command (CLI-level, tested via router)
 * 2. .table() on handles respects column metadata (no rawEventIds/provenance/base64 leak)
 * 3. CPU time computation reads timeDeltas from data (not cpuProfile)
 * 4. pretty() on schema metadata renders column names, not JSON blobs
 */
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";
import { table, pretty } from "../src/core/presentation";

type TracePayload = {
  metadata?: Record<string, any>;
  traceEvents: Record<string, any>[];
};

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "transcript-fix-"));
  tempDirs.push(dir);
  return dir;
}

function createTraceFile(trace: TracePayload) {
  const dir = createTempDir();
  const filePath = join(dir, "trace.json");
  writeFileSync(filePath, JSON.stringify(trace));
  return filePath;
}

/**
 * Trace with CPU profile where timeDeltas is at data level (real-world Chrome format)
 * AND a screenshot with base64 data to test column filtering.
 */
function traceWithDataLevelTimeDeltas(): TracePayload {
  return {
    traceEvents: [
      {
        cat: "__metadata",
        name: "process_name",
        ph: "M",
        pid: 1,
        tid: 0,
        ts: 0,
        args: { name: "Renderer" },
      },
      {
        cat: "__metadata",
        name: "thread_name",
        ph: "M",
        pid: 1,
        tid: 1,
        ts: 0,
        args: { name: "CrRendererMain" },
      },
      {
        cat: "disabled-by-default-devtools.screenshot",
        name: "Screenshot",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1000,
        args: {
          snapshot: Buffer.from("fake-jpeg-data-for-testing").toString("base64"),
          frame_sequence: 1,
        },
      },
      // ProfileChunk with timeDeltas at data level (NOT inside cpuProfile)
      {
        cat: "disabled-by-default-v8.cpu_profiler",
        name: "ProfileChunk",
        ph: "P",
        pid: 1,
        tid: 1,
        ts: 2000,
        args: {
          data: {
            cpuProfile: {
              nodes: [
                {
                  id: 1,
                  callFrame: {
                    functionName: "(root)",
                    scriptId: 0,
                    codeType: "other",
                  },
                },
                {
                  id: 2,
                  parent: 1,
                  callFrame: {
                    functionName: "processData",
                    scriptId: 10,
                    url: "http://example.com/app.js",
                    lineNumber: 42,
                    columnNumber: 5,
                    codeType: "JS",
                  },
                },
                {
                  id: 3,
                  parent: 2,
                  callFrame: {
                    functionName: "innerLoop",
                    scriptId: 10,
                    url: "http://example.com/app.js",
                    lineNumber: 50,
                    columnNumber: 10,
                    codeType: "JS",
                  },
                },
              ],
              // samples but NO timeDeltas here
              samples: [2, 3, 3, 2, 3],
            },
            // timeDeltas at the data level (the real Chrome format)
            timeDeltas: [500, 200, 300, 150, 250],
          },
        },
      },
      // Second ProfileChunk re-declaring the same nodes (tests dedup in nodeChildren)
      {
        cat: "disabled-by-default-v8.cpu_profiler",
        name: "ProfileChunk",
        ph: "P",
        pid: 1,
        tid: 1,
        ts: 3400,
        args: {
          data: {
            cpuProfile: {
              nodes: [
                {
                  id: 1,
                  callFrame: {
                    functionName: "(root)",
                    scriptId: 0,
                    codeType: "other",
                  },
                },
                {
                  id: 2,
                  parent: 1,
                  callFrame: {
                    functionName: "processData",
                    scriptId: 10,
                    url: "http://example.com/app.js",
                    lineNumber: 42,
                    columnNumber: 5,
                    codeType: "JS",
                  },
                },
                {
                  id: 3,
                  parent: 2,
                  callFrame: {
                    functionName: "innerLoop",
                    scriptId: 10,
                    url: "http://example.com/app.js",
                    lineNumber: 50,
                    columnNumber: 10,
                    codeType: "JS",
                  },
                },
              ],
              samples: [3, 2, 3],
            },
            timeDeltas: [100, 400, 200],
          },
        },
      },
    ],
  };
}

async function parseJson(response: Response) {
  return (await response.json()) as Record<string, any>;
}

async function loadSession(file: string, alias?: string) {
  const response = await handleRequest(
    new Request("http://trace-server/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, alias }),
    }),
  );
  expect(response.status).toBe(201);
  return (await parseJson(response)).sessionId as string;
}

async function querySession(sessionId: string, code: string) {
  const response = await handleRequest(
    new Request(`http://trace-server/sessions/${sessionId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
  expect(response.status).toBe(200);
  return parseJson(response);
}

afterEach(() => {
  sessionManager.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("Fix 2: .table() on handles respects column metadata", () => {
  it("screenshot .table() does not include base64 or rawEventIds", async () => {
    const file = createTraceFile(traceWithDataLevelTimeDeltas());
    const sessionId = await loadSession(file);

    const result = await querySession(
      sessionId,
      `return await ds.tables.get('devtools.dims.screenshots').table()`,
    );
    const output = result.result as string;
    // Should NOT contain base64 data
    expect(output).not.toContain("ZmFrZS1qcGVn"); // base64 of "fake-jpeg"
    // Should NOT contain rawEventIds
    expect(output).not.toContain("rawEventIds");
    expect(output).not.toContain("provenance");
    // Should contain declared columns
    expect(output).toContain("screenshotId");
    expect(output).toContain("artifactId");
  });

  it("cpuHotspots .table() does not include rawEventIds", async () => {
    const file = createTraceFile(traceWithDataLevelTimeDeltas());
    const sessionId = await loadSession(file);

    const result = await querySession(
      sessionId,
      `return await ds.tables.get('devtools.views.cpuHotspots').table()`,
    );
    const output = result.result as string;
    expect(output).not.toContain("rawEventIds");
    expect(output).not.toContain("provenance");
    expect(output).toContain("cpuHotspotId");
    expect(output).toContain("functionName");
    expect(output).toContain("selfTimeMs");
  });
});

describe("Fix 3: CPU time computation reads timeDeltas from data level", () => {
  it("selfTimeMs and totalTimeMs are non-zero when timeDeltas is at data level", async () => {
    const file = createTraceFile(traceWithDataLevelTimeDeltas());
    const sessionId = await loadSession(file);

    const result = await querySession(
      sessionId,
      `
      const hotspots = await ds.tables.get('devtools.views.cpuHotspots')
        .orderBy('selfTimeMs', 'desc')
        .rows();
      return hotspots.map(h => ({
        fn: h.functionName,
        selfMs: h.selfTimeMs,
        totalMs: h.totalTimeMs,
        samples: h.sampleCount,
      }));
      `,
    );
    const rows = JSON.parse(result.result as string);
    expect(rows.length).toBeGreaterThan(0);

    // Find innerLoop and processData
    const innerLoop = rows.find((r: any) => r.fn === "innerLoop");
    const processData = rows.find((r: any) => r.fn === "processData");

    expect(innerLoop).toBeDefined();
    expect(processData).toBeDefined();

    // Chunk 1 samples [2,3,3,2,3]: node 3 hit 3 times, node 2 hit 2 times
    // Chunk 2 samples [3,2,3]: node 3 hit 2 times, node 2 hit 1 time
    // innerLoop (node 3): 3+2 = 5 samples
    // processData (node 2): 2+1 = 3 samples
    expect(innerLoop.selfMs).toBeGreaterThan(0);
    expect(processData.selfMs).toBeGreaterThan(0);
    expect(innerLoop.samples).toBe(5);
    expect(processData.samples).toBe(3);

    // Verify total times are reasonable (not exponentially large)
    expect(innerLoop.totalMs).toBeLessThan(100);
    expect(processData.totalMs).toBeLessThan(100);
  });

  it("handles duplicate nodes across ProfileChunks without exponential totals", async () => {
    const file = createTraceFile(traceWithDataLevelTimeDeltas());
    const sessionId = await loadSession(file);

    const result = await querySession(
      sessionId,
      `
      const nodes = await ds.tables.get('devtools.dims.cpuNodes')
        .where('nodeId', '=', '1')
        .rows();
      return { totalSamples: nodes[0]?.totalSampleCount, totalMs: nodes[0]?.totalTimeMs };
      `,
    );
    const root = JSON.parse(result.result as string);
    // 8 total samples across both chunks
    expect(root.totalSamples).toBe(8);
    // Sum of all timeDeltas: (500+200+300+150+250) + (100+400+200) = 1400+700 = 2100µs = 2.1ms
    expect(root.totalMs).toBeCloseTo(2.1, 0);
  });

  it("still works when timeDeltas is inside cpuProfile (legacy format)", async () => {
    // Legacy format: timeDeltas inside cpuProfile
    const trace: TracePayload = {
      traceEvents: [
        {
          cat: "__metadata",
          name: "process_name",
          ph: "M",
          pid: 1,
          tid: 0,
          ts: 0,
          args: { name: "Renderer" },
        },
        {
          cat: "__metadata",
          name: "thread_name",
          ph: "M",
          pid: 1,
          tid: 1,
          ts: 0,
          args: { name: "CrRendererMain" },
        },
        {
          cat: "disabled-by-default-v8.cpu_profiler",
          name: "ProfileChunk",
          ph: "P",
          pid: 1,
          tid: 1,
          ts: 1000,
          args: {
            data: {
              cpuProfile: {
                nodes: [
                  {
                    id: 1,
                    callFrame: { functionName: "(root)", scriptId: 0, codeType: "other" },
                  },
                  {
                    id: 2,
                    parent: 1,
                    callFrame: {
                      functionName: "legacyFunc",
                      scriptId: 5,
                      codeType: "JS",
                    },
                  },
                ],
                samples: [2, 2],
                // timeDeltas inside cpuProfile (old format)
                timeDeltas: [300, 400],
              },
            },
          },
        },
      ],
    };
    const file = createTraceFile(trace);
    const sessionId = await loadSession(file);

    const result = await querySession(
      sessionId,
      `
      const hotspots = await ds.tables.get('devtools.views.cpuHotspots').rows();
      const legacyFunc = hotspots.find(h => h.functionName === 'legacyFunc');
      return { selfMs: legacyFunc?.selfTimeMs, samples: legacyFunc?.sampleCount };
      `,
    );
    const data = JSON.parse(result.result as string);
    // timeDeltas [300, 400] = 700µs = 0.7ms
    expect(data.selfMs).toBeCloseTo(0.7, 1);
    expect(data.samples).toBe(2);
  });
});

describe("Fix 4: pretty() on schema metadata", () => {
  it("renders column names instead of JSON blobs", () => {
    const schemaRows = [
      {
        name: "devtools.dims.interactions",
        description: "User interactions",
        columns: [
          { name: "interactionId", type: "string" },
          { name: "type", type: "string" },
          { name: "durationMs", type: "number" },
        ],
      },
      {
        name: "devtools.dims.screenshots",
        description: "Screenshots",
        columns: [
          { name: "screenshotId", type: "string" },
          { name: "timestampMs", type: "number" },
        ],
      },
    ];

    const output = pretty(schemaRows);
    // Should contain column names as comma-separated list
    expect(output).toContain("interactionId, type, durationMs");
    expect(output).toContain("screenshotId, timestampMs");
    // Should NOT contain raw JSON
    expect(output).not.toContain('"name":"interactionId"');
    expect(output).not.toContain('"type":"string"');
  });

  it("table() also renders column names compactly", () => {
    const schemaRows = [
      {
        name: "test.table",
        description: "A test table",
        columns: [
          { name: "id", type: "string" },
          { name: "value", type: "number" },
        ],
      },
    ];

    const output = table(schemaRows);
    expect(output).toContain("id, value");
    expect(output).not.toContain('"name":"id"');
  });
});

describe("Fix 2+4 integration: runtime pretty/table on schema", () => {
  it("pretty(ds.schema.tables()) shows column names not JSON", async () => {
    const file = createTraceFile(traceWithDataLevelTimeDeltas());
    const sessionId = await loadSession(file);

    const result = await querySession(
      sessionId,
      `return pretty(await ds.schema.tables())`,
    );
    const output = result.result as string;
    // Should contain readable column names
    expect(output).toContain("screenshotId");
    expect(output).toContain("functionName");
    // Should NOT contain raw JSON column metadata
    expect(output).not.toContain('"name":"screenshotId"');
  });
});
