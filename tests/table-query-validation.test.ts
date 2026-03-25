import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";

const tempDirs: string[] = [];

function createTempDir() {
  const dir = mkdtempSync(join(tmpdir(), "table-query-validation-"));
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

async function querySession(sessionId: string, code: string) {
  return handleRequest(
    new Request(`http://trace-server/sessions/${sessionId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }),
  );
}

afterEach(() => {
  sessionManager.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("table query validation", () => {
  it("validates operators, columns, pagination, select, and preserves valid queries", async () => {
    const file = createRawFile({
      rows: [
        { id: 1, name: "RunTask", durUs: 500 },
        { id: 2, name: "RunTask", durUs: 1500 },
        { id: 3, name: "Paint", durUs: 1800 },
        { id: 4, name: "RunTask", durUs: 2500 },
      ],
    });
    const sessionId = await loadSession(file);

    const invalidOpResponse = await querySession(
      sessionId,
      "await ds.tables.get('raw.inferred.rows').where('x', 'INVALID_OP' as any, 1).rows()",
    );
    expect(invalidOpResponse.status).toBe(400);
    expect((await parseJson(invalidOpResponse)).error).toContain("Invalid filter operator");

    const missingColumnRowsResponse = await querySession(
      sessionId,
      "await ds.tables.get('raw.inferred.rows').where('nonexistentCol', '=', 1).rows()",
    );
    expect(missingColumnRowsResponse.status).toBe(400);
    expect((await parseJson(missingColumnRowsResponse)).error).toContain(
      "Column 'nonexistentCol' not found",
    );

    const missingColumnCountResponse = await querySession(
      sessionId,
      "await ds.tables.get('raw.inferred.rows').where('nonexistentCol', '=', 1).count()",
    );
    expect(missingColumnCountResponse.status).toBe(400);
    expect((await parseJson(missingColumnCountResponse)).error).toContain(
      "Column 'nonexistentCol' not found",
    );

    const emptySelectResponse = await querySession(
      sessionId,
      "await ds.tables.get('raw.inferred.rows').select([]).limit(3).rows()",
    );
    expect(emptySelectResponse.status).toBe(400);
    expect((await parseJson(emptySelectResponse)).error).toContain(
      "select() requires a non-empty array of column names",
    );

    const negativeLimitResponse = await querySession(
      sessionId,
      "await ds.tables.get('raw.inferred.rows').limit(-1).count()",
    );
    expect(negativeLimitResponse.status).toBe(400);
    expect((await parseJson(negativeLimitResponse)).error).toContain(
      "limit must be a non-negative number",
    );

    const negativeOffsetResponse = await querySession(
      sessionId,
      "await ds.tables.get('raw.inferred.rows').offset(-1).limit(3).rows()",
    );
    expect(negativeOffsetResponse.status).toBe(400);
    expect((await parseJson(negativeOffsetResponse)).error).toContain(
      "offset must be a non-negative number",
    );

    const betweenResponse = await querySession(
      sessionId,
      `
const rows = await ds.tables.get('raw.inferred.rows').where('durUs', 'between', [1000, 2000]).rows();
return rows.map(row => row.id);
`,
    );
    expect(betweenResponse.status).toBe(200);
    expect(JSON.parse((await parseJson(betweenResponse)).result)).toEqual([2, 3]);

    const normalQueryResponse = await querySession(
      sessionId,
      `
const rows = await ds.tables.get('raw.inferred.rows').where('name', '=', 'RunTask').limit(10).rows();
return rows.map(row => row.id);
`,
    );
    expect(normalQueryResponse.status).toBe(200);
    expect(JSON.parse((await parseJson(normalQueryResponse)).result)).toEqual([1, 2, 4]);
  });
});
