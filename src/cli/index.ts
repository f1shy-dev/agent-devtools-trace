#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "trace-server",
    version: "0.1.0",
    description: "Load Chrome DevTools traces and serve query endpoints over a unix socket.",
  },
  subCommands: {
    server: defineCommand({
      meta: {
        name: "server",
        description: "Start the trace server",
      },
      async run() {
        await import("../server/index");
      },
    }),
  },
  async run() {
    await import("../server/index");
  },
});

runMain(main);
