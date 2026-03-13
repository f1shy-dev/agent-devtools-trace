import { gzipSync } from "zlib";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import { loadTrace } from "../src/loader";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("loadTrace", () => {
  it("loads wrapped devtools traces", async () => {
    const trace = await loadTrace("/home/agent-devtools-trace/test-traces/trace-minimal.json");
    expect(trace.metadata.source).toBe("unit-test");
    expect(trace.traceEvents).toHaveLength(3);
  });

  it("loads legacy array traces", async () => {
    const trace = await loadTrace("/home/agent-devtools-trace/test-traces/trace-full.json");
    expect(trace.metadata).toEqual({});
    expect(trace.traceEvents).toHaveLength(2);
  });

  it("loads gzipped traces", async () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-server-"));
    tempDirs.push(dir);
    const filePath = join(dir, "trace.json.gz");
    writeFileSync(
      filePath,
      gzipSync(
        JSON.stringify({
          metadata: { source: "gzip-test" },
          traceEvents: [{ cat: "x", name: "y", ph: "I", pid: 1, tid: 2, ts: 3 }],
        }),
      ),
    );

    const trace = await loadTrace(filePath);
    expect(trace.metadata.source).toBe("gzip-test");
    expect(trace.traceEvents[0]?.name).toBe("y");
  });
});
