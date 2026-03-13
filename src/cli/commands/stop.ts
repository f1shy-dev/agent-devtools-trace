import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { isServerRunning } from "../lifecycle";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default defineCommand({
  meta: { description: "Stop the trace server" },
  async run() {
    try {
      if (!(await isServerRunning())) {
        console.log("Server is not running.");
        return;
      }

      const client = new TraceServerClient();
      await client.stopServer();
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await sleep(100);
        if (!(await isServerRunning())) {
          console.log("✓ Server stopped.");
          return;
        }
      }

      console.log("✓ Stop signal sent.");
    } catch (error) {
      handleCommandError(error);
    }
  },
});
