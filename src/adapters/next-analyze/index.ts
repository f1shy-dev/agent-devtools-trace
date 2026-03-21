import { existsSync, readdirSync, statSync } from "fs";
import { readFile } from "fs/promises";
import { join, relative, resolve, sep } from "path";
import type {
  EndpointContext,
  EndpointHandler,
  EndpointResult,
  TraceAdapter,
} from "../../shared/adapter";
import { AnalyzeData, ModulesData } from "./analyze-data";
import { getModules } from "./heuristics/modules";
import { getRoutes } from "./heuristics/routes";
import { getSizes } from "./heuristics/sizes";
import { getSummary } from "./heuristics/summary";

export interface NextAnalyzeData {
  modulesData: ModulesData;
  routeAnalyzeData: Map<string, AnalyzeData>;
  routes: string[];
}

async function readArrayBuffer(filePath: string): Promise<ArrayBuffer> {
  const bunRuntime = globalThis.Bun;
  if (bunRuntime) {
    return bunRuntime.file(filePath).arrayBuffer();
  }

  const buffer = await readFile(filePath);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

async function readJsonFile<T>(filePath: string): Promise<T> {
  const bunRuntime = globalThis.Bun;
  if (bunRuntime) {
    return (await bunRuntime.file(filePath).json()) as T;
  }

  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function routeToFilePath(baseDir: string, route: string): string {
  if (route === "/") {
    return join(baseDir, "analyze.data");
  }

  return join(baseDir, route.slice(1), "analyze.data");
}

function normalizeRouteFromFile(baseDir: string, filePath: string): string {
  const relativeDir = relative(
    baseDir,
    filePath.replace(new RegExp(`${sep.replace(/\\/g, "\\\\")}analyze\\.data$`), ""),
  );
  if (!relativeDir || relativeDir === ".") {
    return "/";
  }

  return `/${relativeDir.split(sep).join("/")}`;
}

function scanAnalyzeFiles(baseDir: string): Map<string, string> {
  const found = new Map<string, string>();
  const queue = [baseDir];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      continue;
    }

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name === "analyze.data") {
        found.set(normalizeRouteFromFile(baseDir, fullPath), fullPath);
      }
    }
  }

  return found;
}

async function handleSummary(ctx: EndpointContext): Promise<EndpointResult> {
  return getSummary(ctx.session.data as NextAnalyzeData, ctx.session);
}

async function handleRoutes(ctx: EndpointContext): Promise<EndpointResult> {
  return getRoutes(ctx.session.data as NextAnalyzeData);
}

async function handleModules(ctx: EndpointContext): Promise<EndpointResult> {
  return getModules(ctx.session.data as NextAnalyzeData, ctx.searchParams);
}

async function handleSizes(ctx: EndpointContext): Promise<EndpointResult> {
  return getSizes(ctx.session.data as NextAnalyzeData, ctx.searchParams);
}

export class NextAnalyzeAdapter implements TraceAdapter<NextAnalyzeData> {
  readonly type = "next-analyze";

  canLoad(filePath: string): boolean {
    try {
      const stat = statSync(filePath);
      if (!stat.isDirectory()) {
        return false;
      }
      return existsSync(join(filePath, "modules.data"));
    } catch {
      return false;
    }
  }

  async load(filePath: string): Promise<NextAnalyzeData> {
    const baseDir = resolve(filePath);
    const modulesData = new ModulesData(await readArrayBuffer(join(baseDir, "modules.data")));
    const discoveredAnalyzeFiles = scanAnalyzeFiles(baseDir);

    let routes: string[] = [];
    const routesPath = join(baseDir, "routes.json");
    if (existsSync(routesPath)) {
      const loadedRoutes = await readJsonFile<unknown>(routesPath);
      if (Array.isArray(loadedRoutes)) {
        routes = loadedRoutes.filter((route): route is string => typeof route === "string");
      }
    }

    const routeAnalyzeData = new Map<string, AnalyzeData>();
    for (const route of routes) {
      const analyzePath = routeToFilePath(baseDir, route);
      if (!existsSync(analyzePath)) {
        continue;
      }

      routeAnalyzeData.set(route, new AnalyzeData(await readArrayBuffer(analyzePath)));
    }

    const extraRoutes = [...discoveredAnalyzeFiles.keys()]
      .filter((route) => !routeAnalyzeData.has(route))
      .sort((left, right) => left.localeCompare(right));
    for (const route of extraRoutes) {
      const analyzePath = discoveredAnalyzeFiles.get(route);
      if (!analyzePath) {
        continue;
      }

      routeAnalyzeData.set(route, new AnalyzeData(await readArrayBuffer(analyzePath)));
    }

    if (routes.length === 0) {
      routes = [...routeAnalyzeData.keys()].sort((left, right) => left.localeCompare(right));
    } else {
      for (const route of extraRoutes) {
        routes.push(route);
      }
    }

    return {
      modulesData,
      routeAnalyzeData,
      routes,
    };
  }

  getItemCount(data: NextAnalyzeData): number {
    return data.modulesData.moduleCount();
  }

  getEndpoints(): Map<string, EndpointHandler> {
    return new Map([
      ["summary", handleSummary],
      ["routes", handleRoutes],
      ["modules", handleModules],
      ["sizes", handleSizes],
    ]);
  }

  buildQueryContext(
    data: NextAnalyzeData,
    options?: Record<string, string>,
  ): Record<string, unknown> {
    const routeKey = options?.route || "/";
    return {
      modules: data.modulesData,
      analyze: data.routeAnalyzeData.get(routeKey),
      routes: data.routes,
      allAnalyze: data.routeAnalyzeData,
    };
  }
}
