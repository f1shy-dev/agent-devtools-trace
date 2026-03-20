import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { divider, formatBytes, formatNumber, renderTable, truncateMiddle } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "Show size breakdown for a route" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
    route: { type: "string", description: "Route to analyze (default: /)" },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const result = await client.sizes(args.session, args.route || undefined);

      console.log(`Route: ${result.route}`);
      console.log("");

      const outputTypeRows = [
        ["Type", "Count", "Size", "Compressed"],
        ...result.byOutputType.map((entry) => [
          entry.type,
          formatNumber(entry.count),
          formatBytes(entry.size),
          formatBytes(entry.compressedSize),
        ]),
      ];
      const renderedOutputTypes = renderTable(outputTypeRows);
      console.log(renderedOutputTypes[0]);
      console.log(divider(renderedOutputTypes[0]!.length));
      for (const row of renderedOutputTypes.slice(1)) {
        console.log(row);
      }

      console.log("");
      const environmentRows = [
        ["Environment", "Count", "Size", "Compressed"],
        ...result.byEnvironment.map((entry) => [
          entry.env,
          formatNumber(entry.count),
          formatBytes(entry.size),
          formatBytes(entry.compressedSize),
        ]),
      ];
      const renderedEnvironments = renderTable(environmentRows);
      console.log(renderedEnvironments[0]);
      console.log(divider(renderedEnvironments[0]!.length));
      for (const row of renderedEnvironments.slice(1)) {
        console.log(row);
      }

      console.log("");
      const outputFileRows = [
        ["Chunk Parts", "Size", "Compressed", "Filename"],
        ...result.topOutputFiles.map((entry) => [
          formatNumber(entry.chunkParts),
          formatBytes(entry.size),
          formatBytes(entry.compressedSize),
          truncateMiddle(entry.filename, 72),
        ]),
      ];
      const renderedOutputFiles = renderTable(outputFileRows);
      console.log(renderedOutputFiles[0]);
      console.log(divider(renderedOutputFiles[0]!.length));
      for (const row of renderedOutputFiles.slice(1)) {
        console.log(row);
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
