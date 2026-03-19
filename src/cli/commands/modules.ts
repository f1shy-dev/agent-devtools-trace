import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { divider, formatNumber, renderTable, truncateMiddle } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "List top modules by dependency count" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
    route: { type: "string", description: "Route to analyze (default: /)" },
    limit: { type: "string", description: "Max modules to show (default: 50)" },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const limit = args.limit ? Number.parseInt(args.limit, 10) : undefined;
      const result = await client.modules(
        args.session,
        args.route || undefined,
        Number.isFinite(limit) ? limit : undefined,
      );

      if (result.modules.length === 0) {
        console.log("No modules found.");
        return;
      }

      console.log(`Route: ${result.route}`);
      console.log(`Total modules: ${formatNumber(result.totalModules)}`);
      console.log("");

      const rows = [
        ["#", "Deps", "Dependents", "Async Deps", "Async Dependents", "Path"],
        ...result.modules.map((module) => [
          String(module.index),
          formatNumber(module.dependencyCount),
          formatNumber(module.dependentCount),
          formatNumber(module.asyncDependencyCount),
          formatNumber(module.asyncDependentCount),
          truncateMiddle(module.path || module.ident, 72),
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
