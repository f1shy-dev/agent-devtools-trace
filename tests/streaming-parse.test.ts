import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
import { afterEach, describe, expect, it } from "vitest";
import { peekFileText, readMaybeGzipText, streamParseJsonArray } from "../src/core/io";
import { loadSource } from "../src/loader/index";
import { DevtoolsDriver } from "../src/drivers/devtools";
import { RawJsonDriver } from "../src/drivers/raw-json";
import type { SourceProbe } from "../src/core/types";

const LARGE_TRACE_PATH = "/tmp/town-ought-copy.gz";
const MEDIUM_TRACE_PATH = "/home/Trace-20260325T143247.json.gz";
const tempDirs: string[] = [];
const HAS_LARGE_TRACE = existsSync(LARGE_TRACE_PATH);
const HAS_MEDIUM_TRACE = existsSync(MEDIUM_TRACE_PATH);
const HAS_SMOKE_TRACES = loadTraceCandidates().length > 0;

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "trace-streaming-"));
  tempDirs.push(dir);
  return dir;
}

function createProbe(filePath: string): SourceProbe {
  const stat = statSync(filePath);
  return {
    path: filePath,
    isDirectory: stat.isDirectory(),
    sizeBytes: stat.size,
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeDevtoolsTrace(payload: unknown) {
  if (Array.isArray(payload)) {
    return { metadata: {}, traceEvents: payload as Record<string, any>[] };
  }
  if (!isRecord(payload) || !Array.isArray(payload.traceEvents)) {
    throw new Error("Invalid DevTools trace payload for test");
  }
  return {
    metadata: isRecord(payload.metadata)
      ? (payload.metadata as Record<string, any>)
      : Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "traceEvents")),
    traceEvents: payload.traceEvents as Record<string, any>[],
  };
}

function memorySnapshot(label: string) {
  const usage = process.memoryUsage();
  const snapshot = {
    heapUsedMB: Number((usage.heapUsed / 1024 / 1024).toFixed(1)),
    rssMB: Number((usage.rss / 1024 / 1024).toFixed(1)),
    externalMB: Number((usage.external / 1024 / 1024).toFixed(1)),
  };
  console.info(`[memory] ${label}`, snapshot);
  return snapshot;
}

function loadTraceCandidates() {
  const roots = ["/tmp", "/home"];
  return roots.flatMap((root) => {
    if (!existsSync(root)) return [];
    return readdirSync(root)
      .filter((name) => name.endsWith(".json.gz"))
      .map((name) => join(root, name))
      .sort();
  });
}

async function streamTrace(filePath: string) {
  const traceEvents: Record<string, any>[] = [];
  const result = await streamParseJsonArray(filePath, {
    onItem: (item) => traceEvents.push(item as Record<string, any>),
  });
  return {
    metadata: isRecord(result.prefix.metadata)
      ? (result.prefix.metadata as Record<string, any>)
      : result.prefix,
    traceEvents,
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("streaming trace parsing", () => {
  it("peeks plain json files without reading the whole file", async () => {
    const dir = createTempDir();
    const filePath = join(dir, "sample.json");
    writeFileSync(filePath, JSON.stringify({ alpha: 1, beta: 2, gamma: 3 }));

    await expect(peekFileText(filePath, 12)).resolves.toBe('{"alpha":1,"');
  });

  it("peeks gzip json files from decompressed bytes", async () => {
    const dir = createTempDir();
    const filePath = join(dir, "sample.json.gz");
    writeFileSync(filePath, gzipSync(Buffer.from('{"traceEvents":[{"name":"A"},{"name":"B"}]}')));

    const head = await peekFileText(filePath, 18);
    expect(head).toBe('{"traceEvents":[{"');
  });

  it.skipIf(!HAS_LARGE_TRACE)("peeks the 1023MB gzip trace without crashing", async () => {
    const head = await peekFileText(LARGE_TRACE_PATH, 64 * 1024);
    expect(head.length).toBeGreaterThan(1024);
    expect(["{", "["]).toContain(head.trimStart()[0]);
  }, 120000);

  it.skipIf(!HAS_LARGE_TRACE || !HAS_MEDIUM_TRACE)(
    "detects large and small devtools traces via peeking",
    async () => {
    const driver = new DevtoolsDriver();

    const largeStart = performance.now();
    const largeDetection = await driver.detect(createProbe(LARGE_TRACE_PATH));
    const largeDurationMs = performance.now() - largeStart;
    console.info(`[detect] ${LARGE_TRACE_PATH} ${largeDurationMs.toFixed(1)}ms`);
    expect(largeDetection).toEqual({ kind: "devtools", driverId: driver.id });
    expect(largeDurationMs).toBeLessThan(500);

    const smallDetection = await driver.detect(createProbe(MEDIUM_TRACE_PATH));
    expect(smallDetection).toEqual({ kind: "devtools", driverId: driver.id });
    },
    120000,
  );

  it.skipIf(!HAS_MEDIUM_TRACE)("keeps raw-json detection away from devtools traces", async () => {
    const rawDriver = new RawJsonDriver();
    const devtoolsDriver = new DevtoolsDriver();

    await expect(rawDriver.detect(createProbe(MEDIUM_TRACE_PATH))).resolves.toBeNull();
    await expect(devtoolsDriver.detect(createProbe(MEDIUM_TRACE_PATH))).resolves.toEqual({
      kind: "devtools",
      driverId: devtoolsDriver.id,
    });
  }, 120000);

  it.skipIf(!HAS_LARGE_TRACE)("loads the 1023MB trace and queries devtools facts", async () => {
    memorySnapshot("before large trace load");
    const startedAt = performance.now();
    const session = await loadSource(LARGE_TRACE_PATH);
    const loadedAt = performance.now();
    const afterLoad = memorySnapshot("after large trace load");

    expect(session.manifest.kind).toBe("devtools");
    expect((session.manifest.itemCount ?? 0)).toBeGreaterThan(2_000_000);

    const factCount = await session.countTable("devtools.facts.events");
    const afterFacts = memorySnapshot("after devtools.facts.events count");
    console.info(
      `[load] ${LARGE_TRACE_PATH} load=${(loadedAt - startedAt).toFixed(1)}ms count=${factCount} rss=${afterFacts.rssMB}MB`,
    );

    expect(factCount).toBe(session.manifest.itemCount);
    expect(afterLoad.rssMB).toBeLessThan(3072);
    expect(afterFacts.rssMB).toBeLessThan(3072);
  }, 600000);

  it.skipIf(!HAS_SMOKE_TRACES)("loads every json.gz trace from /tmp and /home", async () => {
    const traceFiles = loadTraceCandidates();

    for (const filePath of traceFiles) {
      const before = memorySnapshot(`before ${filePath}`);
      const startedAt = performance.now();
      const session = await loadSource(filePath);
      const durationMs = performance.now() - startedAt;
      const after = memorySnapshot(`after ${filePath}`);
      console.info(
        `[smoke] ${filePath} size=${(statSync(filePath).size / 1024 / 1024).toFixed(1)}MB.gz items=${session.manifest.itemCount ?? 0} load=${durationMs.toFixed(1)}ms rss=${after.rssMB}MB heap=${after.heapUsedMB}MB beforeRss=${before.rssMB}MB`,
      );
      expect(session.manifest.itemCount ?? 0).toBeGreaterThan(0);
    }
  }, 600000);

  it.skipIf(!HAS_MEDIUM_TRACE)("matches sync and streaming trace parsing for a medium trace", async () => {
    const syncTrace = normalizeDevtoolsTrace(JSON.parse(await readMaybeGzipText(MEDIUM_TRACE_PATH)));
    const streamedTrace = await streamTrace(MEDIUM_TRACE_PATH);

    expect(streamedTrace.traceEvents.length).toBe(syncTrace.traceEvents.length);
    expect(streamedTrace.traceEvents[0]).toEqual(syncTrace.traceEvents[0]);
    expect(streamedTrace.traceEvents.at(-1)).toEqual(syncTrace.traceEvents.at(-1));
    expect(Object.keys(streamedTrace.metadata).sort()).toEqual(Object.keys(syncTrace.metadata).sort());
  }, 120000);

  it.skipIf(!HAS_LARGE_TRACE)("streams and profiles memory for the large trace parser", async () => {
    memorySnapshot("before streamParseJsonArray large trace");
    let itemCount = 0;
    const startedAt = performance.now();
    const result = await streamParseJsonArray(LARGE_TRACE_PATH, {
      onItem: () => {
        itemCount += 1;
      },
    });
    const durationMs = performance.now() - startedAt;
    const after = memorySnapshot("after streamParseJsonArray large trace");
    console.info(
      `[stream] ${LARGE_TRACE_PATH} items=${itemCount} metadataKeys=${Object.keys(result.prefix).length} duration=${durationMs.toFixed(1)}ms rss=${after.rssMB}MB`,
    );

    expect(itemCount).toBeGreaterThan(2_000_000);
    expect(after.rssMB).toBeLessThan(3072);
  }, 600000);
});
