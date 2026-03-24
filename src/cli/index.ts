#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { resolve } from "path";
import { TraceServerClient } from "./client.js";
import { handleCommandError } from "./errors.js";
import { divider, formatNumber, renderTable } from "./format.js";
import { ensureServer } from "./lifecycle.js";

function printJson(value: unknown) {
  console.log(JSON.stringify(value, null, 2));
}

function parseOptionalJson(value?: string) {
  return value ? (JSON.parse(value) as Record<string, unknown>) : undefined;
}

function parseOptionalNumber(value?: string) {
  return value ? Number.parseInt(value, 10) : undefined;
}

function parseSelect(value?: string) {
  return value?.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseWhere(value?: string) {
  if (!value) return undefined;
  const [column, op, ...rest] = value.split(":");
  if (!column || !op) throw new Error("where must be in the form column:op:value");
  const rawValue = rest.join(":");
  let parsed: unknown = rawValue;
  if (rawValue === "true") parsed = true;
  else if (rawValue === "false") parsed = false;
  else if (rawValue === "null") parsed = null;
  else if (rawValue && !Number.isNaN(Number(rawValue))) parsed = Number(rawValue);
  return { column, op, value: parsed };
}

function printRenderedOrJson(payload: { rendered?: string; result?: unknown; rows?: unknown[] }) {
  if (typeof payload.rendered === "string") {
    console.log(payload.rendered);
    return;
  }
  if (payload.result !== undefined) {
    printJson(payload.result);
    return;
  }
  if (payload.rows !== undefined) {
    printJson(payload.rows);
    return;
  }
  printJson(payload);
}

function printMatrix(rows: string[][]) {
  if (rows.length === 0) return;
  const rendered = renderTable(rows);
  console.log(rendered[0]);
  console.log(divider(rendered[0]!.length));
  for (const row of rendered.slice(1)) console.log(row);
}

function shorten(text: string, max = 72) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

const main = defineCommand({
  meta: {
    name: "trace-server",
    version: "1.0.0",
    description: "Runtime-first dataset kernel for DevTools traces and raw JSON. Query through ds, pretty(...), and table(...).",
  },
  subCommands: {
    load: defineCommand({
      meta: { name: "load", description: "Load a dataset file into the server and return its session id." },
      args: {
        file: { type: "positional", required: true, description: "Path to a supported dataset file." },
        alias: { type: "string", description: "Optional human-friendly session alias." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const result = await client.loadSession(resolve(args.file), args.alias || undefined);
          console.log(`✓ Loaded session: ${result.sessionId}`);
          console.log(`  Kind: ${result.kind}`);
          console.log(`  Source: ${result.source}`);
          console.log(`  Items: ${result.itemCount ?? 0}`);
          console.log(`  Memory: ${result.memorySizeMB.toFixed(1)} MB`);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    sessions: defineCommand({
      meta: { name: "sessions", description: "List loaded sessions." },
      async run() {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const sessions = await client.listSessions();
          if (sessions.length === 0) {
            console.log("No sessions loaded.");
            return;
          }
          const rows = [
            ["ID", "Kind", "Alias", "Items", "Source"],
            ...sessions.map((session) => [
              session.id,
              session.kind,
              session.alias ?? "",
              formatNumber(session.itemCount ?? 0),
              session.source,
            ]),
          ];
          printMatrix(rows);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    info: defineCommand({
      meta: { name: "info", description: "Show session metadata." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.getSession(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    caps: defineCommand({
      meta: { name: "caps", description: "Show detected dataset capabilities." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.caps(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    schema: defineCommand({
      meta: { name: "schema", description: "Show the dataset schema registry (tables, reports, collections)." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.schema(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    tables: defineCommand({
      meta: { name: "tables", description: "List dataset tables in a readable registry view." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        json: { type: "boolean", description: "Print raw JSON instead of the default table view." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const tables = await client.tables(args.session);
          if (args.json) {
            printJson(tables);
            return;
          }
          if (tables.length === 0) {
            console.log("No tables registered.");
            return;
          }
          printMatrix([
            ["Name", "Columns", "Description"],
            ...tables.map((table) => [
              table.name,
              String(table.columns.length),
              shorten(table.description),
            ]),
          ]);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    table: defineCommand({
      meta: { name: "table", description: "Query one table. Defaults to deterministic table rendering; use --json for raw rows." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        table: { type: "positional", required: true, description: "Table name, e.g. devtools.views.codeHotspots." },
        limit: { type: "string", alias: "l", description: "Optional row limit." },
        select: { type: "string", description: "Comma-separated projection columns." },
        sort: { type: "string", description: "Sort column name." },
        desc: { type: "boolean", description: "Sort descending." },
        where: { type: "string", description: "Single filter in the form column:op:value." },
        pretty: { type: "boolean", description: "Use adaptive pretty rendering instead of deterministic table rendering." },
        tableFormat: { type: "boolean", alias: "T", description: "Explicitly request deterministic table rendering (the default)." },
        json: { type: "boolean", description: "Return raw JSON rows instead of rendered output." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const query: Record<string, unknown> = {};
          const limit = parseOptionalNumber(args.limit);
          if (typeof limit === "number" && Number.isFinite(limit)) query.limit = limit;
          const select = parseSelect(args.select);
          if (select && select.length > 0) query.select = select;
          const where = parseWhere(args.where);
          if (where) query.where = [where];
          if (args.sort) query.orderBy = [{ column: args.sort, direction: args.desc ? "desc" : "asc" }];
          if (!args.json) query.format = args.pretty ? "pretty" : "table";
          const payload = await client.table(args.session, args.table, query);
          printRenderedOrJson(payload);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    reports: defineCommand({
      meta: { name: "reports", description: "List dataset reports in a readable registry view." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        json: { type: "boolean", description: "Print raw JSON instead of the default table view." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const reports = await client.reports(args.session);
          if (args.json) {
            printJson(reports);
            return;
          }
          if (reports.length === 0) {
            console.log("No reports registered.");
            return;
          }
          printMatrix([
            ["Name", "Description"],
            ...reports.map((report) => [report.name, shorten(report.description)]),
          ]);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    report: defineCommand({
      meta: { name: "report", description: "Run a named report. Defaults to readable pretty output; use --json for raw structured data." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        report: { type: "positional", required: true, description: "Report name, e.g. devtools.summary." },
        args: { type: "string", description: "Optional JSON object of report args." },
        pretty: { type: "boolean", description: "Explicitly request readable rendering (the default)." },
        json: { type: "boolean", description: "Return raw JSON instead of the report's readable rendering." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const reportArgs = parseOptionalJson(args.args) ?? {};
          if (!args.json) reportArgs.format = "pretty";
          const payload = await client.report(args.session, args.report, reportArgs);
          printRenderedOrJson(payload);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    query: defineCommand({
      meta: { name: "query", description: "Run JS/TS against the dataset runtime (ds, pretty, table)." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        code: { type: "positional", required: true, description: "Inline JS/TS code to execute." },
        timeout: { type: "string", alias: "t", description: "Optional timeout in milliseconds." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const result = await client.query(args.session, args.code, args.timeout ? Number.parseInt(args.timeout, 10) : undefined);
          console.log(result.result);
          console.error(`(${result.duration}ms)`);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    artifacts: defineCommand({
      meta: { name: "artifacts", description: "List dataset artifacts." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.artifacts(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    artifact: defineCommand({
      meta: { name: "artifact", description: "Show one artifact's metadata." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        artifact: { type: "positional", required: true, description: "Artifact id." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.artifact(args.session, args.artifact));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    collections: defineCommand({
      meta: { name: "collections", description: "List exportable file collections." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.collections(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    materialize: defineCommand({
      meta: { name: "materialize", description: "Materialize one artifact into the managed workspace." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        artifact: { type: "positional", required: true, description: "Artifact id." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.materializeArtifact(args.session, args.artifact));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    export: defineCommand({
      meta: { name: "export", description: "Export a file collection to disk in the managed workspace." },
      args: {
        session: { type: "positional", required: true, description: "Session id or alias." },
        collection: { type: "positional", required: true, description: "Collection id." },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.exportCollection(args.session, args.collection));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    layers: defineCommand({
      meta: { name: "layers", description: "Show layer build/cache status." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.layers(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    leases: defineCommand({
      meta: { name: "leases", description: "Show workspace/export leases for a session." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.leases(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    unload: defineCommand({
      meta: { name: "unload", description: "Unload one session and clean up its workspace." },
      args: { session: { type: "positional", required: true, description: "Session id or alias." } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.deleteSession(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    status: defineCommand({
      meta: { name: "status", description: "Show server health." },
      async run() {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.health());
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    stop: defineCommand({
      meta: { name: "stop", description: "Stop the background server." },
      async run() {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.stopServer());
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
  },
});

runMain(main);
