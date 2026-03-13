import { afterEach, describe, expect, it } from "vitest";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";

async function parseJson(response: Response) {
  return (await response.json()) as Record<string, any>;
}

afterEach(() => {
  sessionManager.clear();
});

describe("server router", () => {
  it("reports health", async () => {
    const response = await handleRequest(new Request("http://trace-server/health"));
    expect(response.status).toBe(200);
    const payload = await parseJson(response);
    expect(payload.status).toBe("ok");
  });

  it("loads, queries, lists, and deletes sessions", async () => {
    const loadResponse = await handleRequest(
      new Request("http://trace-server/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          file: "/home/agent-devtools-trace/test-traces/trace-minimal.json",
          alias: "minimal",
        }),
      }),
    );

    expect(loadResponse.status).toBe(201);
    const loadPayload = await parseJson(loadResponse);
    expect(loadPayload.events).toBe(3);
    expect(loadPayload.sessionId).toMatch(/^[0-9a-f]{8}$/);

    const sessionId = String(loadPayload.sessionId);
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
    expect(queryPayload.result).toBe(2);
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
    expect(statementPayload.result).toEqual(["Screenshot"]);

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
