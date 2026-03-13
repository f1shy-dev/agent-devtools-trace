#!/usr/bin/env bun
import { join } from "path";
import { statSync } from "fs";

const BASE_TS = 1_000_000;

interface TraceEvent {
  cat: string;
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: Record<string, any>;
  id?: string;
  s?: string;
}

const TINY_JPEG = Buffer.from(
  new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
    0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01,
    0x01, 0x01, 0x01, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11,
    0x00, 0xff, 0xc4, 0x00, 0x14, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xc4, 0x00, 0x14, 0x10, 0x01, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x7b, 0x40, 0x00, 0x00, 0x00,
    0xff, 0xd9,
  ]),
).toString("base64");

function us(ms: number): number {
  return ms * 1000;
}

const events: TraceEvent[] = [];

function addBatch(
  name: string,
  cat: string,
  pid: number,
  tid: number,
  startOffsetMs: number,
  count: number,
  spacingMs: number,
  baseDurMs: number,
  args?: Record<string, any>,
): void {
  for (let i = 0; i < count; i++) {
    events.push({
      cat,
      name,
      ph: "X",
      pid,
      tid,
      ts: BASE_TS + us(startOffsetMs + i * spacingMs),
      dur: us(baseDurMs + (i % 7) * 2),
      ...(args ? { args } : {}),
    });
  }
}

// ── Metadata (ph:"M", ts:0) — triggers the getTraceBounds bug ──

events.push(
  { cat: "__metadata", name: "process_name", ph: "M", pid: 1, tid: 0, ts: 0, args: { name: "Renderer" } },
  { cat: "__metadata", name: "process_name", ph: "M", pid: 2, tid: 0, ts: 0, args: { name: "Browser" } },
  { cat: "__metadata", name: "process_name", ph: "M", pid: 3, tid: 0, ts: 0, args: { name: "GPU Process" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 1, ts: 0, args: { name: "CrRendererMain" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 2, ts: 0, args: { name: "Compositor" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 1, tid: 3, ts: 0, args: { name: "CompositorTileWorker" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 2, tid: 1, ts: 0, args: { name: "CrBrowserMain" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 2, tid: 2, ts: 0, args: { name: "IOThread" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 3, tid: 1, ts: 0, args: { name: "CrGpuMain" } },
  { cat: "__metadata", name: "thread_name", ph: "M", pid: 3, tid: 2, ts: 0, args: { name: "VizCompositorThread" } },
);

// ── Renderer main thread (pid:1, tid:1) ──

addBatch("RunTask", "devtools.timeline", 1, 1, 0, 80, 60, 5);
addBatch("FunctionCall", "devtools.timeline", 1, 1, 10, 50, 95, 3);
addBatch("EvaluateScript", "devtools.timeline", 1, 1, 50, 30, 160, 10);
addBatch("RecalculateStyles", "devtools.timeline", 1, 1, 100, 40, 120, 4);
addBatch("Layout", "devtools.timeline,layout", 1, 1, 200, 30, 160, 8);
addBatch("Paint", "devtools.timeline,paint", 1, 1, 300, 30, 160, 6);
addBatch("EventDispatch", "devtools.timeline", 1, 1, 400, 20, 240, 5);
addBatch("TimerFire", "devtools.timeline", 1, 1, 500, 20, 240, 4);
addBatch("ParseHTML", "devtools.timeline,loading", 1, 1, 25, 20, 240, 15);

// Long tasks (dur > 50ms)
events.push(
  { cat: "devtools.timeline", name: "RunTask", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(150), dur: us(120) },
  { cat: "devtools.timeline", name: "EvaluateScript", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(500), dur: us(85), args: { data: { url: "https://example.com/bundle.js" } } },
  { cat: "devtools.timeline", name: "RunTask", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(1200), dur: us(200) },
  { cat: "devtools.timeline", name: "RecalculateStyles", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(2000), dur: us(75) },
  { cat: "devtools.timeline,layout", name: "Layout", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(2500), dur: us(150) },
  { cat: "devtools.timeline", name: "FunctionCall", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(3500), dur: us(95) },
  { cat: "devtools.timeline", name: "RunTask", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(4200), dur: us(65) },
);

// ── Compositor thread (pid:1, tid:2) ──

addBatch("BeginFrame", "cc,benchmark", 1, 2, 0, 30, 167, 2);
addBatch("CompositeLayers", "cc", 1, 2, 5, 30, 167, 3);

// ── CompositorTileWorker (pid:1, tid:3) ──

addBatch("RasterTask", "cc", 1, 3, 50, 25, 200, 8);

// ── Browser main thread (pid:2, tid:1) ──

addBatch("RunTask", "devtools.timeline", 2, 1, 0, 30, 167, 4);

// ── GPU main thread (pid:3, tid:1) ──

addBatch("GPUTask", "gpu", 3, 1, 10, 20, 250, 3);

// ── VizCompositor thread (pid:3, tid:2) ──

addBatch("DrawFrame", "viz", 3, 2, 15, 20, 250, 5);

// ── Network requests (5 lifecycles) ──

const networkRequests = [
  { id: "net-1", url: "https://example.com/", method: "GET", status: 200, mime: "text/html", type: "Document", priority: "VeryHigh", startMs: 50, responseMs: 120, finishMs: 180, encoded: 15000, decoded: 45000 },
  { id: "net-2", url: "https://example.com/app.js", method: "GET", status: 200, mime: "application/javascript", type: "Script", priority: "High", startMs: 200, responseMs: 350, finishMs: 500, encoded: 85000, decoded: 250000 },
  { id: "net-3", url: "https://example.com/styles.css", method: "GET", status: 200, mime: "text/css", type: "Stylesheet", priority: "VeryHigh", startMs: 210, responseMs: 300, finishMs: 380, encoded: 12000, decoded: 48000 },
  { id: "net-4", url: "https://api.example.com/data", method: "POST", status: 201, mime: "application/json", type: "XHR", priority: "High", startMs: 1500, responseMs: 1800, finishMs: 1850, encoded: 2000, decoded: 8000 },
  { id: "net-5", url: "https://example.com/logo.png", method: "GET", status: 304, mime: "image/png", type: "Image", priority: "Low", startMs: 250, responseMs: 280, finishMs: 320, encoded: 0, decoded: 0 },
];

for (const req of networkRequests) {
  events.push(
    {
      cat: "loading",
      name: "ResourceSendRequest",
      ph: "X",
      pid: 1,
      tid: 1,
      ts: BASE_TS + us(req.startMs),
      dur: us(1),
      args: {
        data: {
          requestId: req.id,
          url: req.url,
          requestMethod: req.method,
          priority: req.priority,
          resourceType: req.type,
          initiator: { type: "parser", url: "https://example.com" },
        },
      },
    },
    {
      cat: "loading",
      name: "ResourceReceiveResponse",
      ph: "X",
      pid: 1,
      tid: 1,
      ts: BASE_TS + us(req.responseMs),
      dur: us(1),
      args: {
        data: {
          requestId: req.id,
          statusCode: req.status,
          mimeType: req.mime,
          fromCache: req.status === 304,
        },
      },
    },
    {
      cat: "loading",
      name: "ResourceFinish",
      ph: "X",
      pid: 1,
      tid: 1,
      ts: BASE_TS + us(req.finishMs),
      dur: us(1),
      args: {
        data: {
          requestId: req.id,
          encodedDataLength: req.encoded,
          decodedBodyLength: req.decoded,
        },
      },
    },
  );
}

// ── Screenshots (5) ──

for (let i = 0; i < 5; i++) {
  events.push({
    cat: "disabled-by-default-devtools.screenshot",
    name: "Screenshot",
    ph: "O",
    pid: 1,
    tid: 0,
    ts: BASE_TS + us(i * 1000 + 100),
    args: { snapshot: TINY_JPEG },
  });
}

// ── Instant events (ph:"I") ──

events.push(
  { cat: "loading,devtools.timeline", name: "NavigationStart", ph: "I", pid: 1, tid: 1, ts: BASE_TS, args: { data: { url: "https://example.com/" } }, s: "t" },
  { cat: "blink.user_timing", name: "MarkDOMContent", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(350), args: { data: { url: "https://example.com/" } }, s: "t" },
  { cat: "devtools.timeline", name: "MarkDOMContent", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(355), args: { data: {} }, s: "t" },
  { cat: "blink.user_timing", name: "MarkFirstPaint", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(400), args: { data: {} }, s: "t" },
  { cat: "devtools.timeline", name: "MarkFirstPaint", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(405), args: { data: {} }, s: "t" },
  { cat: "loading", name: "firstContentfulPaint", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(420), args: { data: {} }, s: "t" },
  { cat: "loading", name: "firstMeaningfulPaint", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(450), args: { data: {} }, s: "t" },
  { cat: "blink.user_timing", name: "MarkLoad", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(600), args: { data: { url: "https://example.com/" } }, s: "t" },
  { cat: "devtools.timeline", name: "MarkLoad", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(610), args: { data: {} }, s: "t" },
  { cat: "loading", name: "largestContentfulPaint::Candidate", ph: "I", pid: 1, tid: 1, ts: BASE_TS + us(800), args: { data: { size: 15000 } }, s: "t" },
);

// ── V8 source rundown (ScriptCatchup) ──

events.push(
  { cat: "disabled-by-default-v8.source_rundown", name: "ScriptCatchup", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(60), dur: us(5), args: { data: { sourceUrl: "https://example.com/app.js", sourceMapUrl: "https://example.com/app.js.map" } } },
  { cat: "disabled-by-default-v8.source_rundown", name: "ScriptCatchup", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(70), dur: us(3), args: { data: { sourceUrl: "https://example.com/vendor.js", sourceMapUrl: "https://example.com/vendor.js.map" } } },
  { cat: "disabled-by-default-v8.source_rundown", name: "ScriptCatchup", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(80), dur: us(2), args: { data: { sourceUrl: "https://example.com/utils.js" } } },
  { cat: "disabled-by-default-v8.source_rundown", name: "ScriptCatchup", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(90), dur: us(4), args: { data: { sourceUrl: "https://cdn.example.com/lib.js", sourceMapUrl: "https://cdn.example.com/lib.js.map" } } },
  { cat: "disabled-by-default-v8.source_rundown", name: "ScriptCatchup", ph: "X", pid: 1, tid: 1, ts: BASE_TS + us(95), dur: us(1), args: { data: { sourceUrl: "https://example.com/polyfill.js" } } },
);

// ── Sort chronologically ──

events.sort((a, b) => a.ts - b.ts || a.pid - b.pid || a.tid - b.tid);

// ── Write output ──

const trace = {
  metadata: {
    source: "synthetic-fixture",
    startTime: "2026-01-15T10:00:00.000Z",
  },
  traceEvents: events,
};

const outDir = import.meta.dir;
const jsonPath = join(outDir, "trace-realistic.json");
const gzPath = join(outDir, "trace-realistic.json.gz");

const jsonStr = JSON.stringify(trace, null, 2);
const jsonBuf = Buffer.from(jsonStr);
const gzBuf = Bun.gzipSync(jsonBuf);

await Bun.write(jsonPath, jsonStr);
await Bun.write(gzPath, gzBuf);

const jsonSize = statSync(jsonPath).size;
const gzSize = statSync(gzPath).size;

console.log(`Generated ${events.length} events`);
console.log(`  JSON: ${jsonPath} (${(jsonSize / 1024).toFixed(1)} KB)`);
console.log(`  Gzip: ${gzPath} (${(gzSize / 1024).toFixed(1)} KB)`);
console.log();

const phases = new Map<string, number>();
const names = new Map<string, number>();
for (const e of events) {
  phases.set(e.ph, (phases.get(e.ph) ?? 0) + 1);
  names.set(e.name, (names.get(e.name) ?? 0) + 1);
}

console.log("Phases:");
for (const [ph, count] of [...phases.entries()].sort()) {
  console.log(`  ${ph}: ${count}`);
}

console.log();
console.log("Top event names:");
for (const [name, count] of [...names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  console.log(`  ${name}: ${count}`);
}
