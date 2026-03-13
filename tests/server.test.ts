import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_RESULT_SIZE } from "../src/shared/constants";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";

type TracePayload = {
  metadata?: Record<string, any>;
  traceEvents: Record<string, any>[];
};

const tempDirs: string[] = [];

async function parseJson(response: Response) {
  return (await response.json()) as Record<string, any>;
}

function createTraceFile(trace: TracePayload): string {
  const dir = mkdtempSync(join(tmpdir(), "trace-server-"));
  tempDirs.push(dir);
  const filePath = join(dir, "trace.json");
  writeFileSync(filePath, JSON.stringify(trace));
  return filePath;
}

async function loadSession(file: string, alias?: string): Promise<string> {
  const response = await handleRequest(
    new Request("http://trace-server/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, alias }),
    }),
  );

  expect(response.status).toBe(201);
  const payload = await parseJson(response);
  return String(payload.sessionId);
}

afterEach(() => {
  sessionManager.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("server router", () => {
  it("reports health", async () => {
    const response = await handleRequest(new Request("http://trace-server/health"));
    expect(response.status).toBe(200);
    const payload = await parseJson(response);
    expect(payload.status).toBe("ok");
  });

  it("loads, queries, lists, and deletes sessions", async () => {
    const sessionId = await loadSession(
      "/home/agent-devtools-trace/test-traces/trace-minimal.json",
      "minimal",
    );

    const queryResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "events.filter((event) => event.cat.includes('loading')).length",
        }),
      }),
    );

    expect(queryResponse.status).toBe(200);
    const queryPayload = await parseJson(queryResponse);
    expect(queryPayload.result).toBe("2");
    expect(queryPayload.truncated).toBe(false);

    const statementResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "const screenshots = byPhase.get('O') ?? []; return screenshots.map((event) => event.name);",
        }),
      }),
    );

    expect(statementResponse.status).toBe(200);
    const statementPayload = await parseJson(statementResponse);
    expect(JSON.parse(statementPayload.result)).toEqual(["Screenshot"]);

    const timeoutResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "await new Promise((resolve) => setTimeout(resolve, 50)); return 'done';",
          timeout: 10,
        }),
      }),
    );

    expect(timeoutResponse.status).toBe(408);
    const timeoutPayload = await parseJson(timeoutResponse);
    expect(timeoutPayload.error).toBe("Query timed out after 10ms");

    const truncatedResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: `"x".repeat(${11 * 1024 * 1024})`,
        }),
      }),
    );

    expect(truncatedResponse.status).toBe(200);
    const truncatedPayload = await parseJson(truncatedResponse);
    expect(truncatedPayload.truncated).toBe(true);
    expect(truncatedPayload.result).toHaveLength(MAX_RESULT_SIZE);

    const listResponse = await handleRequest(new Request("http://trace-server/sessions"));
    expect(listResponse.status).toBe(200);
    const listPayload = await parseJson(listResponse);
    expect(listPayload.sessions).toHaveLength(1);
    expect(listPayload.sessions[0]?.alias).toBe("minimal");

    const getResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}`),
    );
    expect(getResponse.status).toBe(200);

    const deleteResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}`, {
        method: "DELETE",
      }),
    );
    expect(deleteResponse.status).toBe(200);
    const deletePayload = await parseJson(deleteResponse);
    expect(deletePayload.ok).toBe(true);
    expect(sessionManager.count()).toBe(0);
  });

  it("serves built-in heuristic endpoints", async () => {
    const screenshotOne = Buffer.from("fake-jpeg-1").toString("base64");
    const screenshotTwo = Buffer.from("fake-jpeg-2").toString("base64");
    const filePath = createTraceFile({
      metadata: {
        source: "heuristics-test",
        startTime: "2026-03-13T00:00:00.000Z",
        sourceMaps: [{ url: "app.js.map" }],
      },
      traceEvents: [
        {
          cat: "__metadata",
          name: "process_name",
          ph: "M",
          pid: 1,
          tid: 1,
          ts: 1000,
          args: { name: "Browser" },
        },
        {
          cat: "__metadata",
          name: "thread_name",
          ph: "M",
          pid: 1,
          tid: 1,
          ts: 1000,
          args: { name: "CrBrowserMain" },
        },
        {
          cat: "__metadata",
          name: "thread_name",
          ph: "M",
          pid: 1,
          tid: 2,
          ts: 1000,
          args: { name: "RendererMain" },
        },
        {
          cat: "loading,devtools.timeline",
          name: "NavigationStart",
          ph: "I",
          pid: 1,
          tid: 1,
          ts: 1000,
          args: { data: { url: "https://example.com" } },
        },
        {
          cat: "disabled-by-default-devtools.screenshot",
          name: "Screenshot",
          ph: "O",
          pid: 1,
          tid: 1,
          ts: 2000,
          args: { snapshot: screenshotOne },
        },
        {
          cat: "disabled-by-default-devtools.screenshot",
          name: "Screenshot",
          ph: "O",
          pid: 1,
          tid: 1,
          ts: 3000,
          args: { snapshot: screenshotTwo },
        },
        {
          cat: "loading",
          name: "ResourceSendRequest",
          ph: "I",
          pid: 1,
          tid: 2,
          ts: 4000,
          args: {
            data: {
              requestId: "req-1",
              url: "https://example.com/app.js",
              requestMethod: "GET",
              priority: "High",
              resourceType: "Script",
              initiator: { type: "parser", url: "https://example.com" },
            },
          },
        },
        {
          cat: "loading",
          name: "ResourceReceiveResponse",
          ph: "I",
          pid: 1,
          tid: 2,
          ts: 4500,
          args: {
            data: {
              requestId: "req-1",
              statusCode: 200,
              mimeType: "application/javascript",
              fromCache: false,
            },
          },
        },
        {
          cat: "loading",
          name: "ResourceFinish",
          ph: "I",
          pid: 1,
          tid: 2,
          ts: 6000,
          args: { data: { requestId: "req-1", encodedDataLength: 1000, decodedBodyLength: 2000 } },
        },
        {
          cat: "devtools.timeline",
          name: "EvaluateScript",
          ph: "X",
          pid: 1,
          tid: 2,
          ts: 7000,
          dur: 90000,
          args: {},
        },
        {
          cat: "devtools.timeline,layout",
          name: "Layout",
          ph: "X",
          pid: 1,
          tid: 2,
          ts: 120000,
          dur: 60000,
          args: {},
        },
      ],
    });
    const sessionId = await loadSession(filePath, "heuristics");

    const summaryResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/summary`),
    );
    expect(summaryResponse.status).toBe(200);
    const summaryPayload = await parseJson(summaryResponse);
    expect(summaryPayload.totalEvents).toBe(11);
    expect(summaryPayload.durationMs).toBe(179);
    expect(summaryPayload.categories).toBe(5);
    expect(summaryPayload.threads).toBe(2);
    expect(summaryPayload.processes).toBe(1);
    expect(summaryPayload.hasScreenshots).toBe(true);
    expect(summaryPayload.screenshotCount).toBe(2);
    expect(summaryPayload.hasNetworkEvents).toBe(true);
    expect(summaryPayload.networkRequestCount).toBe(1);
    expect(summaryPayload.hasSourceMaps).toBe(true);
    expect(summaryPayload.sourceMapCount).toBe(1);
    expect(summaryPayload.phases).toEqual({ M: 3, I: 4, O: 2, X: 2 });
    expect(summaryPayload.topEventNames[0]).toEqual({ name: "Screenshot", count: 2 });

    const categoriesResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/categories`),
    );
    expect(categoriesResponse.status).toBe(200);
    const categoriesPayload = await parseJson(categoriesResponse);
    expect(categoriesPayload.categories[0]).toMatchObject({ category: "loading", count: 4 });
    expect(
      categoriesPayload.categories.find((entry: any) => entry.category === "layout"),
    ).toMatchObject({
      phases: { X: 1 },
      topNames: ["Layout"],
    });

    const threadsResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/threads`),
    );
    expect(threadsResponse.status).toBe(200);
    const threadsPayload = await parseJson(threadsResponse);
    expect(threadsPayload.threads[0]).toMatchObject({
      threadKey: "1:2",
      name: "RendererMain",
      processName: "Browser",
      eventCount: 6,
    });

    const networkResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/network`),
    );
    expect(networkResponse.status).toBe(200);
    const networkPayload = await parseJson(networkResponse);
    expect(networkPayload.requests).toEqual([
      {
        requestId: "req-1",
        url: "https://example.com/app.js",
        method: "GET",
        resourceType: "Script",
        priority: "High",
        startTime: 4000,
        endTime: 6000,
        duration: 2,
        statusCode: 200,
        mimeType: "application/javascript",
        encodedDataLength: 1000,
        decodedBodyLength: 2000,
        fromCache: false,
        initiator: { type: "parser", url: "https://example.com" },
      },
    ]);

    const longTasksResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/long-tasks?threshold=70`),
    );
    expect(longTasksResponse.status).toBe(200);
    const longTasksPayload = await parseJson(longTasksResponse);
    expect(longTasksPayload.thresholdMs).toBe(70);
    expect(longTasksPayload.tasks).toEqual([
      {
        name: "EvaluateScript",
        category: "devtools.timeline",
        durationMs: 90,
        startTimeMs: 6,
        pid: 1,
        tid: 2,
        threadName: "RendererMain",
      },
    ]);

    const screenshotsResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/screenshots`),
    );
    expect(screenshotsResponse.status).toBe(200);
    const screenshotsPayload = await parseJson(screenshotsResponse);
    expect(screenshotsPayload.screenshots).toEqual([
      {
        index: 0,
        timestamp: 2000,
        timestampMs: 1,
        sizeBytes: 11,
        base64Length: screenshotOne.length,
      },
      {
        index: 1,
        timestamp: 3000,
        timestampMs: 2,
        sizeBytes: 11,
        base64Length: screenshotTwo.length,
      },
    ]);

    const screenshotImageResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/screenshots/1`),
    );
    expect(screenshotImageResponse.status).toBe(200);
    expect(screenshotImageResponse.headers.get("Content-Type")).toBe("image/jpeg");
    expect(Buffer.from(await screenshotImageResponse.arrayBuffer()).toString()).toBe("fake-jpeg-2");

    const extractDir = join(tmpdir(), `trace-server-extract-${sessionId}`);
    const extractResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/screenshots/extract`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ outputDir: extractDir }),
      }),
    );
    expect(extractResponse.status).toBe(200);
    const extractPayload = await parseJson(extractResponse);
    expect(extractPayload.dir).toBe(extractDir);
    expect(extractPayload.count).toBe(2);
    expect(extractPayload.files).toHaveLength(2);
    expect(readFileSync(extractPayload.files[0], "utf8")).toBe("fake-jpeg-1");
  });

  it("returns 400 for invalid query code or body", async () => {
    const response = await handleRequest(
      new Request("http://trace-server/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );
    expect(response.status).toBe(400);
    const payload = await parseJson(response);
    expect(payload.error).toBe("Invalid JSON body");
  });
});
