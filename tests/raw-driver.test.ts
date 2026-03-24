import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "dataset-kernel-raw-"));
  tempDirs.push(dir);
  return dir;
}

function createRawFile(payload: unknown) {
  const dir = createTempDir();
  const filePath = join(dir, "data.json");
  writeFileSync(filePath, JSON.stringify(payload));
  return filePath;
}

async function parseJson(response: Response) {
  return (await response.json()) as Record<string, any>;
}

async function loadSession(file: string) {
  const response = await handleRequest(
    new Request("http://trace-server/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file }),
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

describe("raw json driver", () => {
  it("loads raw json and exposes inferred tables and reports", async () => {
    const file = createRawFile([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
    const sessionId = await loadSession(file);

    const infoResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}`));
    expect(infoResponse.status).toBe(200);
    const infoPayload = await parseJson(infoResponse);
    expect(infoPayload.kind).toBe("raw-json");

    const schemaResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/schema`));
    const schemaPayload = await parseJson(schemaResponse);
    expect(schemaPayload.tables.some((table: any) => table.name === "raw.inferred.main")).toBe(true);
    expect(schemaPayload.reports.some((report: any) => report.name === "raw.summary")).toBe(true);

    const reportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("raw.summary")}`, {
        method: "POST",
      }),
    );
    const reportPayload = await parseJson(reportResponse);
    expect(reportPayload.result.topLevelType).toBe("array");
    expect(reportPayload.result.inferredTables[0].rows).toBe(2);

    const queryResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: `
const rows = await (await ds.tables.get('raw.inferred.main')).rows();
return rows.map(row => row.name).join(',');
`,
        }),
      }),
    );
    const queryPayload = await parseJson(queryResponse);
    expect(queryPayload.result).toBe('"alpha,beta"');
  });
});
