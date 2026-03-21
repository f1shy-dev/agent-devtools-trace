import { defineCommand } from "citty";
import { TraceServerClient } from "../client";
import { handleCommandError } from "../errors";
import { ensureServer } from "../lifecycle";

export default defineCommand({
  meta: { description: "Run TypeScript code against a loaded session" },
  args: {
    session: { type: "positional", description: "Session ID or alias", required: true },
    code: { type: "positional", description: "TypeScript code to execute", required: false },
    file: { type: "string", alias: "f", description: "Read code from file instead" },
    timeout: { type: "string", alias: "t", description: "Timeout in ms" },
    route: { type: "string", alias: "r", description: "Route for analyze sessions" },
  },
  async run({ args }) {
    try {
      await ensureServer();
      const client = new TraceServerClient();

      let code = args.code;
      if (args.file) {
        code = await Bun.file(args.file).text();
      }
      if (!code) {
        console.error("Error: provide code as argument or via --file/-f");
        process.exit(1);
      }

      const timeout = args.timeout ? Number.parseInt(args.timeout, 10) : undefined;
      const result = await client.query(args.session, code, timeout, args.route || undefined);

      if (result.truncated) {
        console.warn("⚠ Result was truncated (exceeded 10MB)");
      }
      console.log(
        typeof result.result === "string" ? result.result : JSON.stringify(result.result, null, 2),
      );
      console.error(`(${result.duration}ms)`);
    } catch (error) {
      handleCommandError(error);
    }
  },
});
