import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { divider, formatNumber, formatPercent, renderTable } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "Show event category distribution" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const categories = await client.categories(args.session);

      if (categories.length === 0) {
        console.log("No categories found.");
        return;
      }

      const rows = [
        ["Category", "Count", "%"],
        ...categories.map((category) => [
          category.category || "(none)",
          formatNumber(category.count),
          formatPercent(category.percentage),
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
