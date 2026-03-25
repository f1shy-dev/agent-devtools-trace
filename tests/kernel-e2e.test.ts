import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";

type TracePayload = {
  metadata?: Record<string, any>;
  traceEvents: Record<string, any>[];
};

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dataset-kernel-"));
  tempDirs.push(dir);
  return dir;
}

function createTraceFile(trace: TracePayload) {
  const dir = createTempDir();
  const filePath = join(dir, "trace.json");
  writeFileSync(filePath, JSON.stringify(trace));
  return filePath;
}

function sampleTrace(): TracePayload {
  return {
    metadata: {
      source: "unit-test",
      startTime: "2026-03-24T00:00:00.000Z",
      sourceMaps: [
        {
          url: "http://example.com/app.js",
          sourceMapUrl: "http://example.com/app.js.map",
          sourceMap: {
            version: 3,
            file: "app.js",
            names: [],
            sources: ["src/app.ts"],
            sourcesContent: ['export const value = "héllo 🌍";'],
            mappings: "",
          },
        },
      ],
    },
    traceEvents: [
      { cat: "__metadata", name: "process_name", ph: "M", pid: 1, tid: 0, ts: 0, args: { name: "Renderer" } },
      { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 1, ts: 0, args: { name: "CrRendererMain" } },
      { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 2, ts: 0, args: { name: "DedicatedWorker thread" } },
      {
        cat: "disabled-by-default-devtools.screenshot",
        name: "Screenshot",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1000,
        args: { snapshot: Buffer.from("fake-jpeg").toString("base64"), frame_sequence: 7 },
      },
      {
        cat: "disabled-by-default-devtools.v8-source-rundown-sources",
        name: "ScriptCatchup",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 1010,
        dur: 5,
        args: {
          data: {
            scriptId: 10,
            url: "http://example.com/app.js",
            sourceText: "console.log('héllo 🌍 from inline source')",
          },
        },
      },
      {
        cat: "devtools.timeline",
        name: "ResourceSendRequest",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1020,
        args: { data: { requestId: "req-1", url: "http://example.com/data.json", requestMethod: "GET", frame: "frame-1" } },
      },
      {
        cat: "devtools.timeline",
        name: "ResourceReceiveResponse",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1030,
        args: {
          data: {
            requestId: "req-1",
            statusCode: 200,
            mimeType: "application/json",
            protocol: "h2",
            fromCache: false,
            headers: [{ name: "content-type", value: "application/json" }],
            timing: { receiveHeadersEnd: 5.2 },
          },
        },
      },
      {
        cat: "devtools.timeline",
        name: "ResourceReceivedData",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1045,
        args: {
          data: {
            requestId: "req-1",
            body: `data:application/json;base64,${Buffer.from(JSON.stringify({ ok: true })).toString("base64")}`,
          },
        },
      },
      {
        cat: "cc",
        name: "LayerTreeHostImpl::UpdateLayers",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1080,
        args: { data: { layerId: 7 } },
      },
      {
        cat: "devtools.timeline",
        name: "ResourceFinish",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1090,
        args: { data: { requestId: "req-1" } },
      },
      {
        cat: "devtools.timeline",
        name: "WorkerTask",
        ph: "I",
        pid: 1,
        tid: 2,
        ts: 1400,
        args: { data: { workerId: 99, url: "http://example.com/worker.js" } },
      },
      {
        cat: "disabled-by-default-devtools.timeline",
        name: "RunTask",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 1500,
        dur: 10000,
        args: {},
      },
      {
        cat: "devtools.timeline",
        name: "FunctionCall",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 1510,
        dur: 3000,
        args: {
          data: {
            functionName: "renderApp",
            url: "http://example.com/app.js",
            scriptId: 10,
            lineNumber: 12,
            columnNumber: 3,
          },
        },
      },
      {
        cat: "disabled-by-default-v8.cpu_profiler",
        name: "ProfileChunk",
        ph: "P",
        pid: 1,
        tid: 1,
        ts: 2075,
        args: {
          data: {
            cpuProfile: {
              nodes: [
                { id: 1, callFrame: { functionName: "(root)", scriptId: "0", codeType: "other" } },
                { id: 2, parent: 1, callFrame: { functionName: "renderApp", scriptId: "10", url: "http://example.com/app.js", lineNumber: 12, columnNumber: 3, codeType: "JS" } },
              ],
              samples: [2, 2, 2],
              timeDeltas: [100, 100, 100],
            },
          },
        },
      },
      {
        cat: "loading",
        name: "SoftNavigation",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 1995,
        args: {},
      },
      {
        cat: "loading",
        name: "SoftNavigationHeuristics::CreateNewContext",
        ph: "n",
        pid: 1,
        tid: 1,
        ts: 1996,
        args: { context: { softNavContextId: 12, domModifications: 0 } },
      },
      {
        cat: "devtools.timeline",
        name: "EventTiming",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 2000,
        args: {
          data: {
            type: "pointerup",
            interactionId: 4758,
            duration: 232.042,
            processingStart: 1,
            processingEnd: 2,
            commitFinishTime: 3,
            timeStamp: 4,
          },
        },
      },
      {
        cat: "devtools.timeline",
        name: "EventTiming",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 2000,
        args: {
          data: {
            type: "click",
            interactionId: 4758,
            duration: 232.042,
            processingStart: 1,
            processingEnd: 2,
            commitFinishTime: 3,
            timeStamp: 4,
          },
        },
      },
      {
        cat: "devtools.timeline",
        name: "EventDispatch",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 2010,
        dur: 201805,
        args: { data: { type: "click" } },
      },
      {
        cat: "blink.user_timing",
        name: "ChatBlock",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 2050,
        args: {
          traceId: 123,
          detail: JSON.stringify({
            devtools: {
              track: "Components",
              tooltipText: "ChatBlock",
              properties: [["context", "Referentially unequal but deeply equal"]],
            },
          }),
        },
      },
      {
        cat: "devtools.timeline",
        name: "UserTiming::Measure",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 2060,
        dur: 2000,
        args: { sampleTraceId: 123 },
      },
      {
        cat: "blink.user_timing",
        name: "VirtualItem",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 2070,
        args: {
          traceId: 124,
          detail: JSON.stringify({
            devtools: {
              track: "Components",
              tooltipText: "VirtualItem",
              properties: [["children", "changed"]],
            },
          }),
        },
      },
      {
        cat: "devtools.timeline",
        name: "UserTiming::Measure",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 2080,
        dur: 3000,
        args: { sampleTraceId: 124 },
      },
      {
        cat: "loading",
        name: "LayoutShift",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 2090,
        args: { data: { score: 0.12, cumulative_score: 0.12, had_recent_input: true, impacted_nodes: [{ node_id: 1 }] } },
      },
      {
        cat: "loading",
        name: "SoftNavigationContext::AddedModifiedNodeInAnimationFrame",
        ph: "n",
        pid: 1,
        tid: 1,
        ts: 2095,
        args: { context: { softNavContextId: 12, domModifications: 4 } },
      },
      {
        cat: "benchmark",
        name: "PipelineReporter",
        ph: "b",
        pid: 1,
        tid: 1,
        ts: 2100,
        args: { frame_reporter: { state: "STATE_DROPPED", frame_sequence: 7, affects_smoothness: true, has_high_latency: true, submit_to_present_ms: 8.5 } },
      },
      {
        cat: "devtools.timeline",
        name: "Paint",
        ph: "X",
        pid: 1,
        tid: 1,
        ts: 2110,
        dur: 500,
        args: {},
      },
      {
        cat: "devtools.timeline",
        name: "AnimationFrame::Presentation",
        ph: "n",
        pid: 1,
        tid: 1,
        ts: 2120,
        args: { id: "frame-1" },
      },
    ],
  };
}

function artifactEdgeCaseTrace(): TracePayload {
  const longUrl = `data:text/plain;base64,${Buffer.from("x".repeat(800)).toString("base64")}`;
  const pngDataUrl = `data:image/png;base64,${Buffer.from("fake-png").toString("base64")}`;
  return {
    metadata: {
      source: "unit-test",
      startTime: "2026-03-24T00:00:00.000Z",
    },
    traceEvents: [
      {
        cat: "devtools.timeline",
        name: "ResourceSendRequest",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1000,
        args: {
          data: {
            requestId: "req-png",
            url: longUrl,
            requestMethod: "GET",
            frame: "frame-1",
          },
        },
      },
      {
        cat: "devtools.timeline",
        name: "ResourceReceivedData",
        ph: "I",
        pid: 1,
        tid: 1,
        ts: 1010,
        args: {
          data: {
            requestId: "req-png",
            body: pngDataUrl,
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

afterEach(() => {
  sessionManager.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("dataset kernel e2e", () => {
  it("loads a devtools dataset and exposes schema/caps/tables/reports", async () => {
    const file = createTraceFile(sampleTrace());
    const sessionId = await loadSession(file, "trace");

    const capsResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/caps`));
    expect(capsResponse.status).toBe(200);
    const capsPayload = await parseJson(capsResponse);
    expect(capsPayload.caps.screenshots).toBe(true);
    expect(capsPayload.caps.sourceMaps).toBe(true);
    expect(capsPayload.caps.inlineScriptSource).toBe(true);
    expect(capsPayload.caps.eventTiming).toBe(true);

    const schemaResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/schema`));
    expect(schemaResponse.status).toBe(200);
    const schemaPayload = await parseJson(schemaResponse);
    expect(schemaPayload.kind).toBe("devtools");
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.dims.interactions")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.dims.processes")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.dims.frames")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.facts.cpuSamples")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.views.framePipeline")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.views.codeHotspots")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.views.cpuCallTrees")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "devtools.views.networkWaterfall")).toBe(true);
    expect(schemaPayload.reports.some((report: any) => report.name === "devtools.interaction")).toBe(true);
    expect(schemaPayload.reports.some((report: any) => report.name === "devtools.script")).toBe(true);
    expect(schemaPayload.collections.some((collection: any) => collection.id === "devtools.screenshots")).toBe(true);
    expect(schemaPayload.collections.some((collection: any) => collection.id === "devtools.network-bodies")).toBe(true);

    const schemaPathsResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/schema/paths`));
    expect(schemaPathsResponse.status).toBe(200);
    const schemaPathsPayload = await parseJson(schemaPathsResponse);
    expect(schemaPathsPayload.paths.some((row: any) => row.path === "$.traceEvents[].name")).toBe(true);
  });

  it("supports generic table queries and generic reports", async () => {
    const file = createTraceFile(sampleTrace());
    const sessionId = await loadSession(file);

    const tableResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/tables/${encodeURIComponent("devtools.dims.interactions")}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      }),
    );
    expect(tableResponse.status).toBe(200);
    const tablePayload = await parseJson(tableResponse);
    expect(tablePayload.table).toBe("devtools.dims.interactions");
    expect(tablePayload.rows).toHaveLength(1);
    expect(tablePayload.rows[0].interactionId).toBe("4758");
    expect(tablePayload.rows[0].type).toBe("click");

    const reportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.interaction")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "4758" }),
      }),
    );
    expect(reportResponse.status).toBe(200);
    const reportPayload = await parseJson(reportResponse);
    expect(reportPayload.result.interaction.interactionId).toBe("4758");
    expect(reportPayload.result.topComponents[0].componentName).toBe("ChatBlock");
    expect(reportPayload.result.droppedFrames).toBe(1);
    expect(reportPayload.result.layoutShifts).toHaveLength(1);
    expect(reportPayload.result.softNavigations).toHaveLength(1);
    expect(reportPayload.result.cpuHotspots[0].functionName).toBe("renderApp");

    const prettyReportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.interaction")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "4758", format: "pretty" }),
      }),
    );
    const prettyReportPayload = await parseJson(prettyReportResponse);
    expect(prettyReportPayload.rendered).toContain("interaction 4758 click");

    const framePipelineResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/tables/${encodeURIComponent("devtools.views.framePipeline")}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      }),
    );
    const framePipelinePayload = await parseJson(framePipelineResponse);
    expect(framePipelinePayload.rows[0].frameSequence).toBe("7");
    expect(framePipelinePayload.rows[0].screenshotArtifactId).toBe("artifact:devtools:screenshot:0");
    expect(framePipelinePayload.rows[0].stageTimingsMs.submit_to_present_ms).toBe(8.5);

    const waterfallResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/tables/${encodeURIComponent("devtools.views.networkWaterfall")}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderBy: [{ column: "durationMs", direction: "desc" }] }),
      }),
    );
    const waterfallPayload = await parseJson(waterfallResponse);
    expect(waterfallPayload.rows[0].requestId).toBe("req-1");

    const hotspotsResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.hotspots")}`, {
        method: "POST",
      }),
    );
    const hotspotsPayload = await parseJson(hotspotsResponse);
    expect(hotspotsPayload.result.codeHotspots[0].functionName).toBe("renderApp");
    expect(hotspotsPayload.result.cpuHotspots[0].functionName).toBe("renderApp");
    expect(hotspotsPayload.result.cpuCallTrees[0].stackLabel).toContain("renderApp");

    const cpuSamplesResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/tables/${encodeURIComponent("devtools.facts.cpuSamples")}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 5 }),
      }),
    );
    const cpuSamplesPayload = await parseJson(cpuSamplesResponse);
    expect(cpuSamplesPayload.rows[0].functionName).toBe("renderApp");

    const requestBodiesResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/tables/${encodeURIComponent("devtools.dims.requestBodies")}/query`, {
        method: "POST",
      }),
    );
    const requestBodiesPayload = await parseJson(requestBodiesResponse);
    expect(requestBodiesPayload.rows[0].requestId).toBe("req-1");
    expect(requestBodiesPayload.rows[0].mediaType).toBe("application/json");
  });

  it("validates report ids and keeps summary resilient", async () => {
    const file = createTraceFile(sampleTrace());
    const sessionId = await loadSession(file);

    const interactionDefaultResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.interaction")}`, {
        method: "POST",
      }),
    );
    expect(interactionDefaultResponse.status).toBe(200);
    const interactionDefaultPayload = await parseJson(interactionDefaultResponse);
    expect(interactionDefaultPayload.result.interaction.interactionId).toBe("4758");

    const interactionMissingResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.interaction")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "fake" }),
      }),
    );
    expect(interactionMissingResponse.status).toBe(200);
    const interactionMissingPayload = await parseJson(interactionMissingResponse);
    expect(interactionMissingPayload.result.interaction).toBeNull();
    expect(interactionMissingPayload.result.framePipeline).toEqual([]);

    const frameAliasResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.frame")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "7" }),
      }),
    );
    expect(frameAliasResponse.status).toBe(200);
    const frameAliasPayload = await parseJson(frameAliasResponse);
    expect(frameAliasPayload.result.frame.frameSequence).toBe("7");

    const frameNamedArgResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.frame")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ frameSequence: "7" }),
      }),
    );
    expect(frameNamedArgResponse.status).toBe(200);
    const frameNamedArgPayload = await parseJson(frameNamedArgResponse);
    expect(frameNamedArgPayload.result.frame.frameSequence).toBe("7");

    const frameMissingResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.frame")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "fake" }),
      }),
    );
    expect(frameMissingResponse.status).toBe(200);
    const frameMissingPayload = await parseJson(frameMissingResponse);
    expect(frameMissingPayload.result.frame).toBeNull();

    const requestAliasResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.request")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "req-1" }),
      }),
    );
    expect(requestAliasResponse.status).toBe(200);
    const requestAliasPayload = await parseJson(requestAliasResponse);
    expect(requestAliasPayload.result.request.requestId).toBe("req-1");

    const softNavigationMissingResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.soft-navigation")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: "fake" }),
      }),
    );
    expect(softNavigationMissingResponse.status).toBe(200);
    const softNavigationMissingPayload = await parseJson(softNavigationMissingResponse);
    expect(softNavigationMissingPayload.result.softNavigation).toBeNull();
    expect(softNavigationMissingPayload.result.requests).toEqual([]);

    const session = sessionManager.get(sessionId) as any;
    expect(session).toBeTruthy();
    const originalGet = session.layers.get.bind(session.layers);
    session.layers.get = async (key: string, signal?: AbortSignal) => {
      if (key === "devtools/views.framePipeline") {
        throw new Error("frame pipeline exploded");
      }
      return originalGet(key, signal);
    };

    const summaryResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("devtools.summary")}`, {
        method: "POST",
      }),
    );
    expect(summaryResponse.status).toBe(200);
    const summaryPayload = await parseJson(summaryResponse);
    expect(summaryPayload.result.totalEvents).toBe(28);
    expect(summaryPayload.result.frameReports).toBe(0);
    expect(summaryPayload.result.error).toContain("frame pipeline exploded");
  });

  it("supports querying through the ds runtime", async () => {
    const file = createTraceFile(sampleTrace());
    const sessionId = await loadSession(file);

    const queryResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: `
const summary = await ds.reports.run('devtools.summary');
const interactions = await ds.tables.get('devtools.dims.interactions').rows();
const hotspotsTable = await ds.tables.get('devtools.views.codeHotspots').select(['functionName', 'totalDurationMs']).limit(1).table();
const interactionPretty = await ds.reports.get('devtools.interaction').args({ id: '4758' }).pretty();
return {
  kind: await ds.schema.kind(),
  totalEvents: summary.totalEvents,
  interactionCount: interactions.length,
  hotspotsTable,
  interactionPretty,
  genericPretty: pretty({ ok: true, rows: interactions.length }),
};
`,
        }),
      }),
    );
    expect(queryResponse.status).toBe(200);
    const queryPayload = await parseJson(queryResponse);
    expect(JSON.parse(queryPayload.result)).toEqual({
      kind: "devtools",
      totalEvents: 28,
      interactionCount: 1,
      hotspotsTable: expect.stringContaining("renderApp"),
      interactionPretty: expect.stringContaining("interaction 4758 click"),
      genericPretty: expect.stringContaining("ok"),
    });
  });

  it("lists artifacts and materializes/exports files", async () => {
    const trace = sampleTrace();
    const file = createTraceFile(trace);
    const sessionId = await loadSession(file);

    const artifactsResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/artifacts`));
    expect(artifactsResponse.status).toBe(200);
    const artifactsPayload = await parseJson(artifactsResponse);
    expect(artifactsPayload.artifacts.every((artifact: any) => typeof artifact.hash === "string" && artifact.hash.length === 64)).toBe(true);
    const artifactIds = artifactsPayload.artifacts.map((artifact: any) => artifact.id);
    expect(artifactIds).toContain("artifact:devtools:screenshot:0");
    expect(artifactIds).toContain("artifact:devtools:script:10");
    expect(artifactIds).toContain("artifact:code:sourcemap:0");
    expect(artifactIds).toContain("artifact:code:source:0:0");
    expect(artifactIds).toContain("artifact:devtools:request-body:7:0");
    const scriptArtifact = artifactsPayload.artifacts.find((artifact: any) => artifact.id === "artifact:devtools:script:10");
    const sourceArtifact = artifactsPayload.artifacts.find((artifact: any) => artifact.id === "artifact:code:source:0:0");
    const screenshotArtifact = artifactsPayload.artifacts.find((artifact: any) => artifact.id === "artifact:devtools:screenshot:0");
    const sourceMapArtifact = artifactsPayload.artifacts.find((artifact: any) => artifact.id === "artifact:code:sourcemap:0");
    expect(scriptArtifact.sizeBytes).toBe(Buffer.byteLength(String(trace.traceEvents[4]?.args?.data?.sourceText), "utf8"));
    expect(sourceArtifact.sizeBytes).toBe(
      Buffer.byteLength(String(trace.metadata?.sourceMaps?.[0]?.sourceMap?.sourcesContent?.[0]), "utf8"),
    );
    expect(screenshotArtifact.hash).toBe(
      createHash("sha256").update(Buffer.from("fake-jpeg")).digest("hex"),
    );
    expect(sourceMapArtifact.hash).toBe(
      createHash("sha256")
        .update(JSON.stringify(trace.metadata?.sourceMaps?.[0] ?? null), "utf8")
        .digest("hex"),
    );

    const artifactResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/artifacts/${encodeURIComponent("artifact:devtools:script:10")}`),
    );
    const artifactPayload = await parseJson(artifactResponse);
    expect(artifactPayload.id).toBe("artifact:devtools:script:10");

    const artifactContentResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/artifacts/${encodeURIComponent("artifact:devtools:script:10")}/content`),
    );
    const scriptContent = await artifactContentResponse.text();
    expect(scriptContent).toContain("inline source");
    expect(scriptArtifact.sizeBytes).toBe(Buffer.byteLength(scriptContent, "utf8"));

    const sourceContentResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/artifacts/${encodeURIComponent("artifact:code:source:0:0")}/content`),
    );
    const sourceContent = await sourceContentResponse.text();
    expect(sourceArtifact.sizeBytes).toBe(Buffer.byteLength(sourceContent, "utf8"));

    const requestBodyContentResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/artifacts/${encodeURIComponent("artifact:devtools:request-body:7:0")}/content`),
    );
    expect(await requestBodyContentResponse.text()).toContain('"ok": true');

    const layersResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/layers`));
    const layersPayload = await parseJson(layersResponse);
    expect(layersPayload.layers.some((row: any) => row.key === "devtools/views.framePipeline")).toBe(true);
    expect(layersPayload.layers.some((row: any) => row.key === "devtools/facts.cpuSamples")).toBe(true);

    const materializeResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/artifacts/${encodeURIComponent("artifact:devtools:screenshot:0")}/materialize`, {
        method: "POST",
      }),
    );
    expect(materializeResponse.status).toBe(200);
    const materializePayload = await parseJson(materializeResponse);
    expect(existsSync(materializePayload.path)).toBe(true);
    expect(materializePayload.path.endsWith("screenshot-0000.jpg")).toBe(true);
    expect(materializePayload.path.endsWith(".jpg.jpg")).toBe(false);
    expect(readFileSync(materializePayload.path).toString("utf8")).toContain("fake-jpeg");

    const exportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/files/collections/${encodeURIComponent("code.sources")}/export`, {
        method: "POST",
      }),
    );
    expect(exportResponse.status).toBe(200);
    const exportPayload = await parseJson(exportResponse);
    expect(existsSync(exportPayload.path)).toBe(true);
    expect(existsSync(exportPayload.manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(exportPayload.manifestPath, "utf8"));
    expect(manifest.collectionId).toBe("code.sources");
    expect(exportPayload.fileCount).toBe(1);
    const exportedSourcePath = join(exportPayload.path, manifest.items[0].relativePath);
    expect(readFileSync(exportedSourcePath, "utf8")).toContain('export const value = "héllo 🌍"');

    const leasesResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/files/leases`));
    const leasesPayload = await parseJson(leasesResponse);
    expect(leasesPayload.leases.some((lease: any) => lease.leaseId === materializePayload.leaseId)).toBe(true);

    const pinLeaseResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/files/leases/${encodeURIComponent(materializePayload.leaseId)}/pin`, { method: "POST" }),
    );
    expect((await parseJson(pinLeaseResponse)).lease.pinned).toBe(true);

    const releasePinnedResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/files/leases/${encodeURIComponent(materializePayload.leaseId)}/release`, { method: "POST" }),
    );
    expect((await parseJson(releasePinnedResponse)).ok).toBe(false);

    const unpinLeaseResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/files/leases/${encodeURIComponent(materializePayload.leaseId)}/unpin`, { method: "POST" }),
    );
    expect((await parseJson(unpinLeaseResponse)).lease.pinned).toBe(false);

    const releaseLeaseResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/files/leases/${encodeURIComponent(materializePayload.leaseId)}/release`, { method: "POST" }),
    );
    expect((await parseJson(releaseLeaseResponse)).ok).toBe(true);

    const pinLayerResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/layers/${encodeURIComponent("devtools/views.framePipeline")}/pin`, { method: "POST" }),
    );
    expect((await parseJson(pinLayerResponse)).layer.pinned).toBe(true);

    const evictPinnedLayerResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/layers/${encodeURIComponent("devtools/views.framePipeline")}/evict`, { method: "POST" }),
    );
    expect((await parseJson(evictPinnedLayerResponse)).ok).toBe(false);
  });

  it("materializes png request bodies with media extensions and truncates oversized manifest metadata", async () => {
    const trace = artifactEdgeCaseTrace();
    const file = createTraceFile(trace);
    const sessionId = await loadSession(file);

    const artifactsResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/artifacts`));
    const artifactsPayload = await parseJson(artifactsResponse);
    const pngArtifact = artifactsPayload.artifacts.find(
      (artifact: any) =>
        artifact.id.startsWith("artifact:devtools:request-body:") && artifact.mediaType === "image/png",
    );
    expect(pngArtifact).toBeTruthy();

    const materializeResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/artifacts/${encodeURIComponent(pngArtifact.id)}/materialize`, {
        method: "POST",
      }),
    );
    expect(materializeResponse.status).toBe(200);
    const materializePayload = await parseJson(materializeResponse);
    expect(materializePayload.path.endsWith(".png")).toBe(true);
    expect(materializePayload.path.endsWith(".bin")).toBe(false);

    const exportResponse = await handleRequest(
      new Request(
        `http://trace-server/sessions/${sessionId}/files/collections/${encodeURIComponent("devtools.network-bodies")}/export`,
        { method: "POST" },
      ),
    );
    expect(exportResponse.status).toBe(200);
    const exportPayload = await parseJson(exportResponse);
    const manifest = JSON.parse(readFileSync(exportPayload.manifestPath, "utf8"));
    expect(JSON.stringify(manifest)).not.toContain(trace.traceEvents[0]?.args?.data?.url);
    expect(
      manifest.items.some((item: any) => typeof item.metadata?.url === "string" && item.metadata.url.startsWith("[truncated: ")),
    ).toBe(true);
  });
});
