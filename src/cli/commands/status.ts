import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { formatUptime } from "../format";
import { getServerInfo, isServerRunning } from "../lifecycle";
import { SOCKET_PATH } from "../../shared/constants";

export default defineCommand({
  meta: { description: "Show trace server status" },
  async run() {
    try {
      if (!(await isServerRunning())) {
        console.log("Status: stopped");
        console.log(`Socket: ${SOCKET_PATH}`);
        return;
      }

      const client = new TraceServerClient();
      const [health, info] = await Promise.all([client.health(), Promise.resolve(getServerInfo())]);

      console.log("Status: running");
      console.log(`PID: ${info?.pid ?? health.pid}`);
      console.log(`Socket: ${info?.socketPath ?? SOCKET_PATH}`);
      console.log(`Uptime: ${formatUptime(health.uptime)}`);
      if (info?.startedAt) {
        console.log(`Started: ${info.startedAt}`);
      }
      console.log(`Sessions: ${health.sessions}`);
      console.log(`Total memory: ${health.memoryMB} MB`);
    } catch (error) {
      handleCommandError(error);
    }
  },
});
