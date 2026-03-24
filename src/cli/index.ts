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

const main = defineCommand({
  meta: {
    name: "trace-server",
    version: "1.0.0",
    description: "Unified dataset kernel for traces, telemetry, bundles, and raw data.",
  },
  subCommands: {
    load: defineCommand({
      meta: { description: "Load a dataset into the server" },
      args: {
        file: { type: "positional", required: true },
        alias: { type: "string" },
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
      meta: { description: "List loaded sessions" },
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
          const rendered = renderTable(rows);
          console.log(rendered[0]);
          console.log(divider(rendered[0]!.length));
          for (const row of rendered.slice(1)) console.log(row);
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    info: defineCommand({
      meta: { description: "Show session metadata" },
      args: { session: { type: "positional", required: true } },
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
    schema: defineCommand({
      meta: { description: "Show dataset schema" },
      args: { session: { type: "positional", required: true } },
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
      meta: { description: "List dataset tables" },
      args: { session: { type: "positional", required: true } },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          printJson(await client.tables(args.session));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    report: defineCommand({
      meta: { description: "Run a named report" },
      args: {
        session: { type: "positional", required: true },
        report: { type: "positional", required: true },
        args: { type: "string" },
      },
      async run({ args }) {
        try {
          await ensureServer();
          const client = new TraceServerClient();
          const reportArgs = args.args ? (JSON.parse(args.args) as Record<string, unknown>) : undefined;
          printJson(await client.report(args.session, args.report, reportArgs));
        } catch (error) {
          handleCommandError(error);
        }
      },
    }),
    query: defineCommand({
      meta: { description: "Run JS/TS against the dataset runtime" },
      args: {
        session: { type: "positional", required: true },
        code: { type: "positional", required: true },
        timeout: { type: "string", alias: "t" },
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
      meta: { description: "List dataset artifacts" },
      args: { session: { type: "positional", required: true } },
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
    export: defineCommand({
      meta: { description: "Export a collection to disk" },
      args: {
        session: { type: "positional", required: true },
        collection: { type: "positional", required: true },
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
    unload: defineCommand({
      meta: { description: "Unload a session" },
      args: { session: { type: "positional", required: true } },
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
      meta: { description: "Show server health" },
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
      meta: { description: "Stop the server" },
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
