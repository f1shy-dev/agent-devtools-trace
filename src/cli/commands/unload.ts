import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "Unload a trace session" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();
      await client.deleteSession(args.session);
      console.log(`✓ Unloaded session: ${args.session}`);
    } catch (error) {
      handleCommandError(error);
    }
  },
});
