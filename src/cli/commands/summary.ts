import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import {
  divider,
  formatBytes,
  formatDurationMs,
  formatNumber,
  renderTable,
  truncateMiddle,
} from "../format";
import { ensureServer } from "../lifecycle";
import type { NextAnalyzeSummaryResponse, SummaryResponse } from "../../shared/types";

export default defineCommand({
  meta: { description: "Show a high-level session summary" },
  args: {
    session: { type: "positional", description: "Session ID or alias", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const summary = await client.summary(args.session);

      if ("type" in summary && summary.type === "next-analyze") {
        const s = summary as NextAnalyzeSummaryResponse;
        console.log(`${formatNumber(s.totalModules)} modules across ${s.totalRoutes} routes`);
        console.log(
          `Sources: ${formatNumber(s.totalSources)}  Output files: ${formatNumber(s.totalOutputFiles)}  Chunk parts: ${formatNumber(s.totalChunkParts)}`,
        );
        console.log(
          `Total size: ${formatBytes(s.totalSize)}  Compressed: ${formatBytes(s.totalCompressedSize)}`,
        );

        if (s.topSourcesBySize.length > 0) {
          console.log("");
          const rows = [
            ["Source", "Size", "Compressed"],
            ...s.topSourcesBySize.map((entry) => [
              truncateMiddle(entry.path, 60),
              formatBytes(entry.size),
              formatBytes(entry.compressedSize),
            ]),
          ];
          const rendered = renderTable(rows);
          console.log(rendered[0]);
          console.log(divider(rendered[0]!.length));
          for (const row of rendered.slice(1)) {
            console.log(row);
          }
        }

        if (s.routes.length > 0) {
          console.log("");
          console.log("Routes:");
          for (const route of s.routes) {
            console.log(`  ${route}`);
          }
        }

        return;
      }

      const s = summary as SummaryResponse;

      console.log(`${formatNumber(s.totalEvents)} events over ${formatDurationMs(s.durationMs)}`);
      console.log(`Processes: ${s.processes}  Threads: ${s.threads}  Categories: ${s.categories}`);
      console.log(
        `Flags: screenshots=${s.screenshotCount}, network=${s.networkRequestCount}, sourceMaps=${s.sourceMapCount}`,
      );
      console.log("");

      const categoryRows = [
        ["Category", "Count", "%"],
        ...s.topCategories.map((entry) => [
          entry.category,
          formatNumber(entry.count),
          `${entry.pct.toFixed(1)}%`,
        ]),
      ];
      const renderedCategories = renderTable(categoryRows);
      console.log(renderedCategories[0]);
      console.log(divider(renderedCategories[0]!.length));
      for (const row of renderedCategories.slice(1)) {
        console.log(row);
      }

      console.log("");
      const eventRows = [
        ["Event", "Count"],
        ...s.topEventNames.map((entry) => [entry.name, formatNumber(entry.count)]),
      ];
      const renderedEvents = renderTable(eventRows);
      console.log(renderedEvents[0]);
      console.log(divider(renderedEvents[0]!.length));
      for (const row of renderedEvents.slice(1)) {
        console.log(row);
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
