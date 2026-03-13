#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";

const main = defineCommand({
  meta: {
    name: "trace-server",
    version: "0.1.0",
    description: "Load-once, query-many server for Chrome DevTools traces",
  },
  subCommands: {
    load: () => import("./commands/load").then((module) => module.default),
    sessions: () => import("./commands/sessions").then((module) => module.default),
    info: () => import("./commands/info").then((module) => module.default),
    query: () => import("./commands/query").then((module) => module.default),
    summary: () => import("./commands/summary").then((module) => module.default),
    categories: () => import("./commands/categories").then((module) => module.default),
    threads: () => import("./commands/threads").then((module) => module.default),
    network: () => import("./commands/network").then((module) => module.default),
    "long-tasks": () => import("./commands/long-tasks").then((module) => module.default),
    screenshots: () => import("./commands/screenshots").then((module) => module.default),
    unload: () => import("./commands/unload").then((module) => module.default),
    stop: () => import("./commands/stop").then((module) => module.default),
    status: () => import("./commands/status").then((module) => module.default),
  },
});

runMain(main);
