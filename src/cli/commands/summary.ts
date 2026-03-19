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

export default defineCommand({
  meta: { description: "Show a high-level trace summary" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const summary = await client.summary(args.session);

      if ("type" in summary && summary.type === "next-analyze") {
        console.log(`${formatNumber(summary.totalModules)} modules across ${summary.totalRoutes} routes`);
        console.log(
          `Sources: ${formatNumber(summary.totalSources)}  Output files: ${formatNumber(summary.totalOutputFiles)}  Chunk parts: ${formatNumber(summary.totalChunkParts)}`,
        );
        console.log(
          `Total size: ${formatBytes(summary.totalSize)}  Compressed: ${formatBytes(summary.totalCompressedSize)}`,
        );

        if (summary.topSourcesBySize.length > 0) {
          console.log("");
          const rows = [
            ["Source", "Size", "Compressed"],
            ...summary.topSourcesBySize.map((entry) => [
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

        if (summary.routes.length > 0) {
          console.log("");
          console.log("Routes:");
          for (const route of summary.routes) {
            console.log(`  ${route}`);
          }
        }

        return;
      }

      console.log(
        `${formatNumber(summary.totalEvents)} events over ${formatDurationMs(summary.durationMs)}`,
      );
      console.log(
        `Processes: ${summary.processes}  Threads: ${summary.threads}  Categories: ${summary.categories}`,
      );
      console.log(
        `Flags: screenshots=${summary.screenshotCount}, network=${summary.networkRequestCount}, sourceMaps=${summary.sourceMapCount}`,
      );
      console.log("");

      const categoryRows = [
        ["Category", "Count", "%"],
        ...summary.topCategories.map((entry) => [
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
        ...summary.topEventNames.map((entry) => [entry.name, formatNumber(entry.count)]),
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
