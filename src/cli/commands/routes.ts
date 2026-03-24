import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { divider, formatBytes, formatNumber, renderTable } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "[next-analyze] List analyzed routes with sizes" },
  args: {
    session: { type: "positional", description: "Session ID or alias", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const result = await client.routes(args.session);

      if (result.routes.length === 0) {
        console.log("No analyzed routes found.");
        return;
      }

      const rows = [
        ["Route", "Sources", "Output Files", "Chunk Parts", "Size", "Compressed"],
        ...result.routes.map((route) => [
          route.route,
          formatNumber(route.sourceCount),
          formatNumber(route.outputFileCount),
          formatNumber(route.chunkPartCount),
          formatBytes(route.totalSize),
          formatBytes(route.totalCompressedSize),
        ]),
      ];
      const rendered = renderTable(rows);
      console.log(rendered[0]);
      console.log(divider(rendered[0]!.length));
      for (const row of rendered.slice(1)) {
        console.log(row);
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
