import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatBytes, formatTimestampMs } from "../format";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "List or extract screenshots" },
  args: {
    session: { type: "positional", description: "Session ID", required: true },
    extract: { type: "boolean", description: "Extract screenshots to disk" },
    dir: { type: "string", description: "Output directory for extraction" },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();

      if (args.extract) {
        const result = await client.extractScreenshots(args.session, args.dir);
        console.log(`✓ Extracted ${result.count} screenshots to ${result.dir}`);
        return;
      }

      const screenshots = await client.screenshots(args.session);
      if (screenshots.length === 0) {
        console.log("No screenshots in this trace.");
        return;
      }

      for (const screenshot of screenshots) {
        console.log(
          `#${screenshot.index}  ${formatTimestampMs(screenshot.timestampMs)}  ${formatBytes(screenshot.sizeBytes)}`,
        );
      }
    } catch (error) {
      handleCommandError(error);
    }
  },
});
