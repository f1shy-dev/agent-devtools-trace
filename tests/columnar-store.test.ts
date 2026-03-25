import { existsSync } from "fs";
import { afterAll, describe, expect, it } from "vitest";
import { ColumnarStore, ColumnarStoreBuilder } from "../src/core/columnar-store";
import { applyTablePlan, columnarApplyPlan, columnarCount } from "../src/core/table-query";
import {
  buildFacts,
  buildFactsRows,
  type FactEvent,
  type ParsedTrace,
} from "../src/drivers/devtools";
import { loadSource } from "../src/loader/index";

const MEDIUM_TRACE_PATH = "/home/Trace-20260325T143247.json.gz";
const LARGE_TRACE_PATH = "/tmp/town-ought-copy.gz";
const HAS_MEDIUM_TRACE = existsSync(MEDIUM_TRACE_PATH);
const HAS_LARGE_TRACE = existsSync(LARGE_TRACE_PATH);

type SampleRow = {
  eventId: string;
  rawIndex: number;
  name: string;
  phase: string;
  threadKey: string;
  tsUs: number;
  durUs: number;
  args: { index: number };
  categories: string[];
  provenance: { rawIds: string[]; layer: string };
};

type MediumFixture = {
  session: Awaited<ReturnType<typeof loadSource>>;
  trace: ParsedTrace;
  store: ColumnarStore<FactEvent>;
  baselineRows: FactEvent[];
};

let mediumFixturePromise: Promise<MediumFixture> | null = null;

function forceGc() {
  const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  if (typeof gc === "function") gc();
}

function heapUsedMB() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

function formatMB(value: number | null | undefined) {
  if (value == null || Number.isNaN(value)) return "n/a";
  return `${value.toFixed(1)} MB`;
}

function formatMs(value: number) {
  return `${value.toFixed(1)} ms`;
}

function formatBytes(value: number) {
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(2)} KB`;
  return `${value} B`;
}

function markdownTable(headers: string[], rows: string[][]) {
  const separator = headers.map(() => "---");
  return [headers, separator, ...rows].map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function measure<T>(fn: () => T) {
  const startedAt = performance.now();
  const result = fn();
  return { result, ms: performance.now() - startedAt };
}

function buildSampleRows(count = 1000): SampleRow[] {
  const phases = ["X", "B", "E", "I", "M"] as const;
  return Array.from({ length: count }, (_, index) => ({
    eventId: `evt:${index}`,
    rawIndex: index,
    name: `Event ${index % 17}`,
    phase: phases[index % phases.length]!,
    threadKey: `${index % 7}:${index % 3}`,
    tsUs: index * 10,
    durUs: index % 5,
    args: { index },
    categories: [`cat:${index % 4}`, `group:${index % 2}`],
    provenance: { rawIds: [`evt:${index}`], layer: "devtools/facts.events" },
  }));
}

function buildSampleStore(rows: SampleRow[]) {
  return new ColumnarStoreBuilder<SampleRow>()
    .addComputedColumn("eventId", (index) => `evt:${index}`)
    .addNumericColumn("rawIndex", "int32")
    .addStringColumn("name")
    .addDictColumn("phase")
    .addDictColumn("threadKey")
    .addNumericColumn("tsUs", "float64")
    .addNumericColumn("durUs", "float64")
    .addRefColumn("args")
    .addStringArrayColumn("categories")
    .addComputedColumn("provenance", (index) => ({
      rawIds: [`evt:${index}`],
      layer: "devtools/facts.events",
    }))
    .buildFromRows(rows);
}

function buildSyntheticTrace(eventCount = 152_000): ParsedTrace {
  const names = [
    "RunTask",
    "Paint",
    "Layout",
    "FunctionCall",
    "ResourceSendRequest",
    "ResourceReceiveResponse",
    "EventDispatch",
    "EvaluateScript",
  ] as const;
  const phases = ["X", "I", "B", "E", "M"] as const;
  const events = Array.from({ length: eventCount }, (_, index) => {
    const pid = 1000 + (index % 4);
    const tid = 200 + (index % 32);
    const ts = index * 137;
    const name = names[index % names.length]!;
    const ph = phases[index % phases.length]!;
    const dur = ph === "X" ? (index % 11) * 37 : 0;
    const requestId = name.includes("Resource") ? `req-${index}` : undefined;
    const scriptId = name === "FunctionCall" || name === "EvaluateScript" ? index % 5000 : undefined;
    return {
      cat: index % 5 === 0 ? "devtools.timeline,loading" : "devtools.timeline",
      name,
      ph,
      pid,
      tid,
      ts,
      dur,
      args: {
        data: {
          requestId,
          url: `https://example.com/${name.toLowerCase()}/${index % 4096}`,
          scriptId,
          frame: `frame-${index % 64}`,
          interactionId: index % 97 === 0 ? index % 10000 : undefined,
          workerId: index % 251 === 0 ? index % 31 : undefined,
          layerId: index % 313 === 0 ? index % 41 : undefined,
          traceId: index % 127 === 0 ? index : undefined,
          nodeId: index % 29 === 0 ? index % 1000 : undefined,
        },
      },
      id: index % 113 === 0 ? index : undefined,
      s: index % 149 === 0 ? `scope-${index % 11}` : undefined,
    };
  });
  return { metadata: { source: "synthetic-152k" }, traceEvents: events };
}

async function getMediumFixture(): Promise<MediumFixture> {
  if (!HAS_MEDIUM_TRACE) {
    throw new Error(`Missing medium trace: ${MEDIUM_TRACE_PATH}`);
  }
  mediumFixturePromise ??= (async () => {
    const session = await loadSource(MEDIUM_TRACE_PATH);
    const trace = await session.layers.getStored<ParsedTrace>("devtools/trace");
    const store = await session.layers.getStored<ColumnarStore<FactEvent>>("devtools/facts.events");
    const baselineRows = buildFactsRows(trace);
    return { session, trace, store, baselineRows };
  })();
  return mediumFixturePromise;
}

afterAll(async () => {
  if (!mediumFixturePromise) return;
  const fixture = await mediumFixturePromise;
  await fixture.session.dispose();
});

describe("ColumnarStore", () => {
  it("round-trips rows through toRows", () => {
    const rows = buildSampleRows();
    const store = buildSampleStore(rows);
    expect(store.length).toBe(rows.length);
    expect(store.toRows()).toEqual(rows);
  });

  it("returns single rows and column values", () => {
    const rows = buildSampleRows();
    const store = buildSampleStore(rows);
    expect(store.getRow(25)).toEqual(rows[25]);
    expect(store.getColumn("tsUs", 25)).toBe(rows[25]!.tsUs);
    expect(store.getColumn("name", 25)).toBe(rows[25]!.name);
  });

  it("dictionary-encodes low-cardinality strings", () => {
    const rows = buildSampleRows();
    const store = buildSampleStore(rows);
    const phaseColumn = store.getDictColumn("phase");
    expect(phaseColumn).not.toBeNull();
    expect(phaseColumn!.dict.sort()).toEqual(["B", "E", "I", "M", "X"]);
    expect(phaseColumn!.indices).toBeInstanceOf(Uint8Array);
  });

  it("computes eventId and provenance on access", () => {
    const store = buildSampleStore(buildSampleRows(3));
    expect(store.getColumn("eventId", 2)).toBe("evt:2");
    expect(store.getColumn("provenance", 2)).toEqual({
      rawIds: ["evt:2"],
      layer: "devtools/facts.events",
    });
  });

  it("estimates memory usage below row-json size for the sample dataset", () => {
    const rows = buildSampleRows();
    const store = buildSampleStore(rows);
    const storeBytes = store.estimateMemoryBytes();
    const jsonBytes = Buffer.byteLength(JSON.stringify(rows));
    expect(storeBytes).toBeGreaterThan(0);
    expect(storeBytes).toBeLessThan(jsonBytes);
  });
});

describe.skipIf(process.env.COLUMNAR_BENCH !== "1")("synthetic 152k benchmark", () => {
  it("prints benchmark and memory tables for a 152k synthetic trace", () => {
    const trace = buildSyntheticTrace();

    forceGc();
    const rowBefore = heapUsedMB();
    const rowBuild = measure(() => buildFactsRows(trace));
    const rows = rowBuild.result;
    const rowAfter = heapUsedMB();

    forceGc();
    const columnarBefore = heapUsedMB();
    const columnarBuild = measure(() => buildFacts(trace));
    const store = columnarBuild.result;
    const columnarAfter = heapUsedMB();

    const phasePlan = { where: [{ column: "phase", op: "=", value: "X" }], limit: 100 };
    const rangePlan = {
      where: [{ column: "tsUs", op: "between", lower: rows[10_000]!.tsUs, upper: rows[30_000]!.tsUs }],
      orderBy: [{ column: "tsUs", direction: "asc" as const }],
      limit: 100,
    };
    const countPlan = { where: [{ column: "name", op: "contains", value: "Paint" }] };

    const coldColumnar = measure(() => columnarApplyPlan(store, phasePlan));
    const coldRows = measure(() => applyTablePlan(rows, phasePlan));
    const rangeColumnar = measure(() => columnarApplyPlan(store, rangePlan));
    const rangeRows = measure(() => applyTablePlan(rows, rangePlan));
    const countColumnar = measure(() => columnarCount(store, countPlan));
    const countRows = measure(() => applyTablePlan(rows, countPlan).length);

    forceGc();
    const materializeBefore = heapUsedMB();
    let materialized = store.toRows();
    const materializeAfter = heapUsedMB();
    materialized = [];
    forceGc();
    const afterRelease = heapUsedMB();

    const fullMaterialize = measure(() => store.toRows());
    const warmColumnar = measure(() => {
      let last = 0;
      for (let index = 0; index < 10; index += 1) {
        last = columnarApplyPlan(store, phasePlan).length;
      }
      return last;
    });
    const warmRows = measure(() => {
      let last = 0;
      for (let index = 0; index < 10; index += 1) {
        last = applyTablePlan(rows, phasePlan).length;
      }
      return last;
    });

    const memoryTable = markdownTable(
      ["Metric", "Value"],
      [
        ["Synthetic events", String(trace.traceEvents.length)],
        ["ColumnarStore estimate", formatBytes(store.estimateMemoryBytes())],
        ["Row JSON estimate", formatBytes(Buffer.byteLength(JSON.stringify(rows)))],
        ["Row build heap delta", formatMB(rowAfter - rowBefore)],
        ["Columnar build heap delta", formatMB(columnarAfter - columnarBefore)],
        ["Materialize heap delta", formatMB(materializeAfter - materializeBefore)],
        ["Heap after materialized rows released", formatMB(afterRelease)],
      ],
    );

    const benchmarkTable = markdownTable(
      ["Benchmark", "Columnar", "Row objects"],
      [
        ["Build time", formatMs(columnarBuild.ms), formatMs(rowBuild.ms)],
        ["Cold query phase='X' limit 100", formatMs(coldColumnar.ms), formatMs(coldRows.ms)],
        ["Range query orderBy tsUs", formatMs(rangeColumnar.ms), formatMs(rangeRows.ms)],
        ["Count name contains 'Paint'", formatMs(countColumnar.ms), formatMs(countRows.ms)],
        ["Full materialization", formatMs(fullMaterialize.ms), "n/a"],
        ["Repeated query x10", formatMs(warmColumnar.ms), formatMs(warmRows.ms)],
      ],
    );

    console.log(`
${memoryTable}

${benchmarkTable}
`);

    expect(store.length).toBe(rows.length);
    expect(coldColumnar.result).toEqual(coldRows.result);
    expect(rangeColumnar.result).toEqual(rangeRows.result);
    expect(countColumnar.result).toBe(countRows.result);
    expect(fullMaterialize.result.length).toBe(rows.length);
    expect(store.estimateMemoryBytes()).toBeLessThan(Buffer.byteLength(JSON.stringify(rows)));
  }, 120000);
});

describe.skipIf(!HAS_MEDIUM_TRACE)("devtools columnar facts integration", () => {
  it("matches event count and boundary rows", async () => {
    const { session, trace, store, baselineRows } = await getMediumFixture();
    expect(store.length).toBe(trace.traceEvents.length);
    expect(store.getRow(0)).toEqual(baselineRows[0]);
    expect(store.getRow(store.length - 1)).toEqual(baselineRows.at(-1));

    const materialized = await session.layers.get<FactEvent[]>("devtools/facts.events");
    expect(Array.isArray(materialized)).toBe(true);
    expect(materialized.length).toBe(baselineRows.length);
    expect(materialized[0]).toEqual(baselineRows[0]);
    expect(materialized.at(-1)).toEqual(baselineRows.at(-1));
  }, 120000);

  it("uses columnar size estimates in layer status", async () => {
    const { session, store } = await getMediumFixture();
    const layer = (await session.layerStatus()).find((row) => row.key === "devtools/facts.events");
    expect(layer?.sizeBytes).toBe(store.estimateMemoryBytes());
  }, 120000);

  it("matches row-based table plans for all filter types", async () => {
    const { session, baselineRows } = await getMediumFixture();
    const otherPhase = baselineRows.find((row) => row.phase !== baselineRows[0]!.phase)?.phase;
    const paintRow = baselineRows.find((row) => row.name.includes("Paint")) ?? baselineRows[0]!;
    const containsNeedle = paintRow.name.slice(0, Math.min(5, paintRow.name.length));
    const tsLower = baselineRows[Math.floor(baselineRows.length / 3)]!.tsUs;
    const tsUpper = baselineRows[Math.min(baselineRows.length - 1, Math.floor(baselineRows.length / 3) + 500)]!.tsUs;
    const plans = [
      { where: [{ column: "phase", op: "=", value: baselineRows[0]!.phase }], limit: 25 },
      { where: [{ column: "tsUs", op: ">", value: tsLower }], limit: 25 },
      { where: [{ column: "tsUs", op: "<", value: tsUpper }], limit: 25 },
      { where: [{ column: "tsUs", op: "between", lower: tsLower, upper: tsUpper }], orderBy: [{ column: "tsUs" as const }] },
      { where: [{ column: "name", op: "contains", value: containsNeedle }], limit: 25 },
      { where: [{ column: "phase", op: "in", values: [baselineRows[0]!.phase, otherPhase ?? baselineRows[0]!.phase] }], limit: 25 },
    ] as const;

    for (const plan of plans) {
      const actual = await session.queryTable("devtools.facts.events", plan);
      const expected = applyTablePlan(baselineRows, plan);
      expect(actual).toEqual(expected);
    }
  }, 120000);

  it("matches row-based count and query helpers", async () => {
    const { store, baselineRows } = await getMediumFixture();
    const plan = {
      where: [{ column: "name", op: "contains", value: "Paint" }],
      orderBy: [{ column: "tsUs", direction: "asc" as const }],
      limit: 100,
    };
    expect(columnarApplyPlan(store, plan)).toEqual(applyTablePlan(baselineRows, plan));
    expect(columnarCount(store, { where: plan.where })).toBe(
      applyTablePlan(baselineRows, { where: plan.where }).length,
    );
  }, 120000);

  it("profiles memory and benchmarks columnar facts", async () => {
    const { trace, store, baselineRows } = await getMediumFixture();
    const phasePlan = {
      where: [{ column: "phase", op: "=", value: "X" }],
      limit: 100,
    };
    const rangePlan = {
      where: [{ column: "tsUs", op: "between", lower: baselineRows[500]!.tsUs, upper: baselineRows[5000]!.tsUs }],
      orderBy: [{ column: "tsUs", direction: "asc" as const }],
      limit: 100,
    };
    const countPlan = { where: [{ column: "name", op: "contains", value: "Paint" }] };

    forceGc();
    const rowBaselineBefore = heapUsedMB();
    const rowBuild = measure(() => buildFactsRows(trace));
    const rowBuildCount = rowBuild.result.length;
    const rowBaselineAfter = heapUsedMB();
    rowBuild.result = [];

    forceGc();
    const columnarBefore = heapUsedMB();
    const columnarBuild = measure(() => buildFacts(trace));
    const columnarBuildCount = columnarBuild.result.length;
    const columnarAfter = heapUsedMB();
    columnarBuild.result = store;

    forceGc();
    const materializeBefore = heapUsedMB();
    let materialized = store.toRows();
    const materializeAfter = heapUsedMB();
    materialized = [];
    forceGc();
    const materializeRecovered = heapUsedMB();

    const coldColumnar = measure(() => columnarApplyPlan(store, phasePlan));
    const coldRows = measure(() => applyTablePlan(baselineRows, phasePlan));
    const rangeColumnar = measure(() => columnarApplyPlan(store, rangePlan));
    const rangeRows = measure(() => applyTablePlan(baselineRows, rangePlan));
    const countColumnar = measure(() => columnarCount(store, countPlan));
    const countRows = measure(() => applyTablePlan(baselineRows, countPlan).length);
    const materializeTime = measure(() => store.toRows());
    materializeTime.result = [];

    const warmColumnar = measure(() => {
      let last = 0;
      for (let index = 0; index < 10; index += 1) {
        last = columnarApplyPlan(store, phasePlan).length;
      }
      return last;
    });
    const warmRows = measure(() => {
      let last = 0;
      for (let index = 0; index < 10; index += 1) {
        last = applyTablePlan(baselineRows, phasePlan).length;
      }
      return last;
    });

    const memoryTable = markdownTable(
      ["Metric", "Value"],
      [
        ["ColumnarStore estimate", formatBytes(store.estimateMemoryBytes())],
        ["Row JSON estimate", formatBytes(Buffer.byteLength(JSON.stringify(baselineRows)))],
        ["Row build heap delta", formatMB(rowBaselineAfter - rowBaselineBefore)],
        ["Columnar build heap delta", formatMB(columnarAfter - columnarBefore)],
        ["Materialize heap delta", formatMB(materializeAfter - materializeBefore)],
        ["Heap after materialized rows released", formatMB(materializeRecovered)],
      ],
    );

    const benchmarkTable = markdownTable(
      ["Benchmark", "Columnar", "Row objects"],
      [
        ["Build time", formatMs(columnarBuild.ms), formatMs(rowBuild.ms)],
        ["Cold query phase='X' limit 100", formatMs(coldColumnar.ms), formatMs(coldRows.ms)],
        ["Range query orderBy tsUs", formatMs(rangeColumnar.ms), formatMs(rangeRows.ms)],
        ["Count name contains 'Paint'", formatMs(countColumnar.ms), formatMs(countRows.ms)],
        ["Full materialization", formatMs(materializeTime.ms), "n/a"],
        ["Repeated query x10", formatMs(warmColumnar.ms), formatMs(warmRows.ms)],
      ],
    );

    console.log(`\n${memoryTable}\n\n${benchmarkTable}\n`);

    expect(columnarBuildCount).toBe(trace.traceEvents.length);
    expect(rowBuildCount).toBe(trace.traceEvents.length);
    expect(coldColumnar.result).toEqual(coldRows.result);
    expect(rangeColumnar.result).toEqual(rangeRows.result);
    expect(countColumnar.result).toBe(countRows.result);
    expect(materializeTime.result.length).toBe(trace.traceEvents.length);
  }, 120000);
});

describe.skipIf(!HAS_LARGE_TRACE)("optional large trace smoke", () => {
  it("builds columnar facts and runs a simple query on the large trace", async () => {
    const session = await loadSource(LARGE_TRACE_PATH);
    try {
      const trace = await session.layers.getStored<ParsedTrace>("devtools/trace");
      const store = await session.layers.getStored<ColumnarStore<FactEvent>>("devtools/facts.events");
      const query = measure(() => columnarApplyPlan(store, {
        where: [{ column: "phase", op: "=", value: "X" }],
        limit: 100,
      }));
      const rowEstimateBytes = trace.traceEvents.length * 583;
      const smokeTable = markdownTable(
        ["Metric", "Value"],
        [
          ["Events", String(trace.traceEvents.length)],
          ["ColumnarStore estimate", formatBytes(store.estimateMemoryBytes())],
          ["Estimated row-object size", formatBytes(rowEstimateBytes)],
          ["Simple query", formatMs(query.ms)],
        ],
      );
      console.log(`\n${smokeTable}\n`);
      expect(store.length).toBe(trace.traceEvents.length);
      expect(query.result.length).toBeLessThanOrEqual(100);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/Failed to parse DevTools trace/i.test(message)) {
        console.warn(`[columnar-smoke] skipping large trace: ${message}`);
        return;
      }
      throw error;
    } finally {
      await session.dispose();
    }
  }, 600000);
});
