import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatNumber } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "[devtools] Show trace threads grouped by process" },
  args: {
    session: { type: "positional", description: "Session ID or alias", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const threads = await client.threads(args.session);

      if (threads.length === 0) {
        console.log("No threads found.");
        return;
      }

      const processOrder: number[] = [];
      const groups = new Map<number, typeof threads>();
      for (const thread of threads) {
        if (!groups.has(thread.pid)) {
          groups.set(thread.pid, []);
          processOrder.push(thread.pid);
        }
        groups.get(thread.pid)!.push(thread);
      }

      for (const pid of processOrder) {
        const group = groups.get(pid)!;
        const processName = group.find((thread) => thread.processName)?.processName ?? "Unknown";
        console.log(`PID ${pid} (${processName})`);
        for (const thread of group) {
          const name = thread.name ?? "(unnamed)";
          console.log(
            `  TID ${thread.tid}  ${name.padEnd(18)}  ${formatNumber(thread.eventCount)} events`,
          );
        }
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
