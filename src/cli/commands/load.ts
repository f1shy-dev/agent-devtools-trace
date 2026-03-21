import { defineCommand } from "citty";
import { resolve } from "path";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatNumber } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "Load a trace file or analysis directory into the server" },
  args: {
    file: {
      type: "positional",
      description: "Path to a trace file (.json, .json.gz) or Next.js analyze directory (.next/diagnostics/analyze/data)",
      required: true,
    },
    alias: { type: "string", description: "Optional alias for the session" },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const result = await client.loadSession(resolve(args.file), args.alias);

      console.log(`✓ Loaded session: ${result.sessionId}`);
      console.log(`  Type: ${result.type}`);
      console.log(`  File: ${result.file}`);
      console.log(`  Events: ${formatNumber(result.events)}`);
      console.log(`  Memory: ${result.memorySizeMB.toFixed(1)} MB`);
    } catch (error) {
      handleCommandError(error);
    }
  },
});
