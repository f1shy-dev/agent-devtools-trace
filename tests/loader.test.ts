import { gzipSync } from "zlib";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { afterEach, describe, expect, it } from "vitest";
import type { DevToolsData } from "../src/adapters/devtools";
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
    const result = await loadTrace("/home/agent-devtools-trace/test-traces/trace-minimal.json");
    const data = result.data as DevToolsData;
    expect(data.trace.metadata.source).toBe("unit-test");
    expect(data.trace.traceEvents).toHaveLength(3);
  });

  it("loads legacy array traces", async () => {
    const result = await loadTrace("/home/agent-devtools-trace/test-traces/trace-full.json");
    const data = result.data as DevToolsData;
    expect(data.trace.metadata).toEqual({});
    expect(data.trace.traceEvents).toHaveLength(2);
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

    const result = await loadTrace(filePath);
    const data = result.data as DevToolsData;
    expect(data.trace.metadata.source).toBe("gzip-test");
    expect(data.trace.traceEvents[0]?.name).toBe("y");
  });
});
