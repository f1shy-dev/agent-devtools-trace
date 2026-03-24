import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
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
    const file = createRawFile({
      rows: [
        { id: 1, name: "alpha", ts: 100 },
        { id: 2, name: "beta", ts: 200 },
      ],
      nested: {
        items: [
          { id: "n1", label: "nested-alpha", ts: 300 },
          { id: "n2", label: "nested-beta", ts: 400 },
        ],
      },
      screenshot: `data:image/png;base64,${Buffer.from("raw-image").toString("base64")}`,
      attachment: {
        encoding: "base64",
        mimeType: "application/json",
        filename: "payload.json",
        body: gzipSync(Buffer.from(JSON.stringify({ nested: true }))).toString("base64"),
      },
      thumbnailBytes: [137, 80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8],
    });
    const sessionId = await loadSession(file);

    const infoResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}`));
    expect(infoResponse.status).toBe(200);
    const infoPayload = await parseJson(infoResponse);
    expect(infoPayload.kind).toBe("raw-json");

    const schemaResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/schema`));
    const schemaPayload = await parseJson(schemaResponse);
    expect(schemaPayload.tables.some((table: any) => table.name === "raw.inferred.rows")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "raw.inferred.nested.items")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "raw.schema.paths")).toBe(true);
    expect(schemaPayload.tables.some((table: any) => table.name === "raw.embeddedBlobs")).toBe(true);
    expect(schemaPayload.reports.some((report: any) => report.name === "raw.summary")).toBe(true);

    const reportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("raw.summary")}`, {
        method: "POST",
      }),
    );
    const reportPayload = await parseJson(reportResponse);
    expect(reportPayload.result.topLevelType).toBe("object");
    expect(reportPayload.result.inferredTables.some((table: any) => table.name === "raw.inferred.rows" && table.rows === 2)).toBe(true);
    expect(reportPayload.result.inferredTables.some((table: any) => table.name === "raw.inferred.nested.items" && table.rows === 2)).toBe(true);
    expect(reportPayload.result.timeFields).toContain("$.rows[].ts");
    expect(reportPayload.result.timeFields).toContain("$.nested.items[].ts");
    expect(reportPayload.result.embeddedBlobCount).toBe(3);

    const prettyReportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/reports/${encodeURIComponent("raw.summary")}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "pretty" }),
      }),
    );
    const prettyReportPayload = await parseJson(prettyReportResponse);
    expect(prettyReportPayload.rendered).toContain("topLevelType");

    const schemaPathsResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/schema/paths`));
    const schemaPathsPayload = await parseJson(schemaPathsResponse);
    expect(schemaPathsPayload.paths.some((row: any) => row.path === "$.rows[].name")).toBe(true);
    expect(schemaPathsPayload.paths.some((row: any) => row.path === "$.nested.items[].label")).toBe(true);

    const samplesResponse = await handleRequest(new Request(`http://trace-server/sessions/${sessionId}/schema/samples?path=${encodeURIComponent("$.rows[].name")}`));
    const samplesPayload = await parseJson(samplesResponse);
    expect(samplesPayload.samples).toEqual(["alpha", "beta"]);

    const queryResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: `
const rows = await ds.tables.get('raw.inferred.rows').rows();
const nested = await ds.tables.get('raw.inferred.nested.items').rows();
const blobs = await ds.tables.get('raw.embeddedBlobs').rows();
return [
  rows.map(row => row.name).join(','),
  nested.map(row => row.label).join(','),
  blobs.length,
  pretty({ ok: true, blobs: blobs.length }),
].join('|');
`,
        }),
      }),
    );
    const queryPayload = await parseJson(queryResponse);
    expect(queryPayload.result).toBe('alpha,beta|nested-alpha,nested-beta|3|ok     true\nblobs  3');

    const filteredTableResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/tables/${encodeURIComponent("raw.inferred.rows")}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ select: ["name"], where: [{ column: "id", op: ">=", value: 2 }] }),
      }),
    );
    const filteredTablePayload = await parseJson(filteredTableResponse);
    expect(filteredTablePayload.rows).toEqual([{ name: "beta" }]);

    const exportResponse = await handleRequest(
      new Request(`http://trace-server/sessions/${sessionId}/files/collections/${encodeURIComponent("raw.embedded-blobs")}/export`, {
        method: "POST",
      }),
    );
    const exportPayload = await parseJson(exportResponse);
    expect(exportPayload.fileCount).toBe(3);
  });
});
