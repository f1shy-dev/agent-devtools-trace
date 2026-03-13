import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatNumber } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "List all loaded sessions" },
  async run() {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      const sessions = await client.listSessions();

      if (sessions.length === 0) {
        console.log("No sessions loaded. Use 'trace-server load <file>' to load a trace.");
        return;
      }

      for (const session of sessions) {
        console.log(
          `${session.id}  ${session.alias || session.file}  (${formatNumber(session.events)} events, ${session.memorySizeMB.toFixed(1)}MB)`,
        );
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
