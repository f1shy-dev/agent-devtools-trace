import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import {
  divider,
  formatDurationMs,
  formatTimestampMs,
  renderTable,
  truncateMiddle,
} from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "[devtools] Find long-running tasks above a duration threshold" },
  args: {
    session: { type: "positional", description: "Session ID or alias", required: true },
    threshold: {
      type: "string",
      description: "Minimum duration in ms (default: 50)",
      default: "50",
    },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const threshold = Number.parseFloat(args.threshold);
      const result = await client.longTasks(
        args.session,
        Number.isFinite(threshold) ? threshold : undefined,
      );

      if (result.tasks.length === 0) {
        console.log(`No tasks found above ${result.thresholdMs}ms.`);
        return;
      }

      const rows = [
        ["Start", "Duration", "Thread", "Name", "Category"],
        ...result.tasks.map((task) => [
          formatTimestampMs(task.startTimeMs),
          formatDurationMs(task.durationMs),
          task.threadName ?? `${task.pid}:${task.tid}`,
          truncateMiddle(task.name, 28),
          truncateMiddle(task.category || "(none)", 28),
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
