import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatBytes, formatDurationMs, formatIsoDate, formatNumber } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "Show detailed session information" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const [session, summary] = await Promise.all([
        client.getSession(args.session),
        client.summary(args.session),
      ]);

      console.log(`Session: ${session.id}`);
      console.log(`File: ${session.file}`);
      if (session.alias) {
        console.log(`Alias: ${session.alias}`);
      }
      console.log(`Events: ${formatNumber(session.events)}`);
      console.log(`Duration: ${formatDurationMs(summary.durationMs)}`);
      console.log(`File size: ${formatBytes(session.fileSizeBytes)}`);
      console.log(`Memory: ${session.memorySizeMB.toFixed(1)} MB`);
      console.log(`Loaded: ${formatIsoDate(session.loadedAt)}`);
      console.log(`Categories: ${formatNumber(summary.categories)}`);
      console.log(`Threads: ${formatNumber(summary.threads)}`);
      console.log(`Screenshots: ${summary.hasScreenshots ? summary.screenshotCount : 0}`);
      console.log(`Network events: ${summary.hasNetworkEvents ? summary.networkRequestCount : 0}`);
      console.log(`Source maps: ${summary.hasSourceMaps ? summary.sourceMapCount : 0}`);
    } catch (error) {
      handleCommandError(error);
    }
  },
});
