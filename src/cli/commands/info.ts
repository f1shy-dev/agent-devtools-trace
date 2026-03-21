import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatBytes, formatDurationMs, formatIsoDate, formatNumber } from "../format";
import { ensureServer } from "../lifecycle";
import type { NextAnalyzeSummaryResponse, SummaryResponse } from "../../shared/types";

export default defineCommand({
  meta: { description: "Show detailed session information" },
  args: {
    session: { type: "positional", description: "Session ID or alias", required: true },
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
      console.log(`File size: ${formatBytes(session.fileSizeBytes)}`);
      console.log(`Memory: ${session.memorySizeMB.toFixed(1)} MB`);
      console.log(`Loaded: ${formatIsoDate(session.loadedAt)}`);
      if ("type" in summary && summary.type === "next-analyze") {
        const s = summary as NextAnalyzeSummaryResponse;
        console.log(`Type: ${session.type}`);
        console.log(`Modules: ${formatNumber(s.totalModules)}`);
        console.log(`Routes: ${formatNumber(s.totalRoutes)}`);
        console.log(`Sources: ${formatNumber(s.totalSources)}`);
        console.log(`Output files: ${formatNumber(s.totalOutputFiles)}`);
        console.log(`Chunk parts: ${formatNumber(s.totalChunkParts)}`);
        console.log(`Total size: ${formatBytes(s.totalSize)}`);
        console.log(`Compressed size: ${formatBytes(s.totalCompressedSize)}`);
      } else {
        const s = summary as SummaryResponse;
        console.log(`Duration: ${formatDurationMs(s.durationMs)}`);
        console.log(`Categories: ${formatNumber(s.categories)}`);
        console.log(`Threads: ${formatNumber(s.threads)}`);
        console.log(`Screenshots: ${s.hasScreenshots ? s.screenshotCount : 0}`);
        console.log(`Network events: ${s.hasNetworkEvents ? s.networkRequestCount : 0}`);
        console.log(`Source maps: ${s.hasSourceMaps ? s.sourceMapCount : 0}`);
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
