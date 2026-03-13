import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import {
  divider,
  formatDurationMs,
  formatNetworkSize,
  renderTable,
  truncateMiddle,
} from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "List network requests from the trace" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const requests = await client.network(args.session);

      if (requests.length === 0) {
        console.log("No network requests found.");
        return;
      }

      const rows = [
        ["Method", "Status", "Duration", "Size", "URL"],
        ...requests.map((request) => [
          request.method || "-",
          request.statusCode?.toString() ?? "-",
          request.duration !== undefined ? formatDurationMs(request.duration) : "-",
          formatNetworkSize(request),
          truncateMiddle(request.url || "-", 72),
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
