import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { AnalyzeData, ModulesData } from "../src/adapters/next-analyze/analyze-data";
import type { NextAnalyzeData } from "../src/adapters/next-analyze";
import { loadTrace } from "../src/loader";
import { handleRequest } from "../src/server/router";
import { sessionManager } from "../src/server/sessions";
import { buildDataFile, writeEdgesData, writeFixture } from "../test-traces/generate-next-analyze-fixture";

const tempDirs: string[] = [];
const fixturePath = "/home/agent-devtools-trace/test-traces/next-analyze";

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function parseJson(response: Response) {
  return (await response.json()) as Record<string, any>;
}

async function loadAnalyzeSession(file: string, alias?: string) {
  const response = await handleRequest(
    new Request("http://trace-server/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file, alias }),
    }),
  );
  expect(response.status).toBe(201);
  return parseJson(response);
}

afterEach(() => {
  sessionManager.clear();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("NextAnalyze binary parser", () => {
  it("parses ModulesData from binary", () => {
    const edges = [
      writeEdgesData([[1], [0, 2], []]),
      writeEdgesData([[], [2], []]),
      writeEdgesData([[1], [0], []]),
      writeEdgesData([[], [], [1]]),
    ];
    let offset = 0;
    const refs = edges.map((section) => {
      const length = 4 + section.offsets.length * 4 + section.data.length * 4;
      const reference = { offset, length };
      offset += length;
      return reference;
    });
    const buffer = buildDataFile(
      {
        modules: [
          { ident: "entry", path: "/entry.ts" },
          { ident: "dep", path: "/dep.ts" },
          { ident: "lazy", path: "/lazy.ts" },
        ],
        module_dependents: refs[0],
        async_module_dependents: refs[1],
        module_dependencies: refs[2],
        async_module_dependencies: refs[3],
      },
      edges,
    );

    const data = new ModulesData(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(data.moduleCount()).toBe(3);
    expect(data.module(1)).toEqual({ ident: "dep", path: "/dep.ts" });
    expect(data.getModuleIndicesFromPath("/dep.ts")).toEqual([1]);
    expect(data.moduleDependents(1)).toEqual([0, 2]);
    expect(data.moduleDependencies(0)).toEqual([1]);
    expect(data.asyncModuleDependencies(2)).toEqual([1]);
    expect(data.asyncModuleDependents(1)).toEqual([2]);
  });

  it("parses AnalyzeData from binary", () => {
    const edges = [
      writeEdgesData([[0, 1], [2], []]),
      writeEdgesData([[], [0], [1, 2], [2]]),
      writeEdgesData([[1], [2, 3], [], []]),
    ];
    let offset = 0;
    const refs = edges.map((section) => {
      const length = 4 + section.offsets.length * 4 + section.data.length * 4;
      const reference = { offset, length };
      offset += length;
      return reference;
    });
    const buffer = buildDataFile(
      {
        sources: [
          { parent_source_index: null, path: "[project]/" },
          { parent_source_index: 0, path: "app/" },
          { parent_source_index: 1, path: "page.tsx" },
          { parent_source_index: 1, path: "styles.css" },
        ],
        chunk_parts: [
          { source_index: 1, output_file_index: 0, size: 120, compressed_size: 60 },
          { source_index: 2, output_file_index: 0, size: 80, compressed_size: 35 },
          { source_index: 3, output_file_index: 1, size: 40, compressed_size: 15 },
        ],
        output_files: [
          { filename: "[client-fs]/app/page.js" },
          { filename: "[client-fs]/app/page.css" },
          { filename: "[project]/trace" },
        ],
        output_file_chunk_parts: refs[0],
        source_chunk_parts: refs[1],
        source_children: refs[2],
        source_roots: [0],
      },
      edges,
    );

    const data = new AnalyzeData(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(data.sourceCount()).toBe(4);
    expect(data.chunkPartCount()).toBe(3);
    expect(data.outputFileCount()).toBe(3);
    expect(data.sourceChildren(1)).toEqual([2, 3]);
    expect(data.outputFileChunkParts(0)).toEqual([0, 1]);
    expect(data.getFullSourcePath(2)).toBe("[project]/app/page.tsx");
    expect(data.getSourceIndexFromPath("[project]/app/page.tsx")).toBe(2);
    expect(data.getOwnSizes(2)).toEqual({ size: 120, compressedSize: 50 });
    expect(data.getRecursiveSizes(1, () => true)).toEqual({ size: 280, compressedSize: 125 });
    expect(data.getSourceFlags(2)).toEqual({
      client: true,
      server: false,
      traced: false,
      js: true,
      css: true,
      json: false,
      asset: false,
    });
  });

  it("handles empty edge data", () => {
    const emptyEdges = writeEdgesData([[].concat(), []]);
    const refs = [{ offset: 0, length: 4 + emptyEdges.offsets.length * 4 + emptyEdges.data.length * 4 }];
    const buffer = buildDataFile(
      {
        modules: [
          { ident: "a", path: "/a.ts" },
          { ident: "b", path: "/b.ts" },
        ],
        module_dependents: refs[0],
        async_module_dependents: refs[0],
        module_dependencies: refs[0],
        async_module_dependencies: refs[0],
      },
      [emptyEdges],
    );
    const data = new ModulesData(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
    expect(data.moduleDependencies(0)).toEqual([]);
    expect(data.moduleDependents(1)).toEqual([]);
    expect(data.asyncModuleDependencies(0)).toEqual([]);
  });
});

describe("NextAnalyze loader", () => {
  it("loads a directory with modules.data and routes", async () => {
    const result = await loadTrace(fixturePath);
    expect(result.adapter.type).toBe("next-analyze");
    const data = result.data as NextAnalyzeData;
    expect(data.routes).toEqual(["/", "/about"]);
    expect(data.modulesData.moduleCount()).toBe(10);
    expect(data.routeAnalyzeData.get("/")?.sourceCount()).toBe(10);
    expect(data.routeAnalyzeData.get("/about")?.chunkPartCount()).toBe(3);
  });

  it("rejects directories without modules.data", async () => {
    const dir = createTempDir("trace-server-next-analyze-missing-");
    mkdirSync(join(dir, "about"), { recursive: true });
    writeFileSync(join(dir, "routes.json"), JSON.stringify(["/"]));
    writeFileSync(join(dir, "about", "analyze.data"), Buffer.from("missing"));
    await expect(loadTrace(dir)).rejects.toThrow(`No loader found for: ${dir}`);
  });

  it("infers routes when routes.json is missing", async () => {
    const dir = createTempDir("trace-server-next-analyze-infer-");
    writeFixture(dir);
    rmSync(join(dir, "routes.json"));
    const result = await loadTrace(dir);
    const data = result.data as NextAnalyzeData;
    expect(data.routes).toEqual(["/", "/about"]);
  });
});

describe("NextAnalyze server endpoints", () => {
  it("loads an analyze directory and returns type next-analyze", async () => {
    const payload = await loadAnalyzeSession(fixturePath, "next-analyze");
    expect(payload.type).toBe("next-analyze");
    expect(payload.events).toBe(10);
  });

  it("serves summary endpoint", async () => {
    const payload = await loadAnalyzeSession(fixturePath);
    const response = await handleRequest(
      new Request(`http://trace-server/sessions/${payload.sessionId}/summary`),
    );
    expect(response.status).toBe(200);
    const summary = await parseJson(response);
    expect(summary.type).toBe("next-analyze");
    expect(summary.totalModules).toBe(10);
    expect(summary.totalRoutes).toBe(2);
    expect(summary.totalSources).toBe(10);
    expect(summary.totalOutputFiles).toBe(5);
    expect(summary.totalChunkParts).toBe(10);
    expect(summary.totalSize).toBe(4784);
    expect(summary.totalCompressedSize).toBe(2022);
    expect(summary.topSourcesBySize[0]).toEqual({
      path: "[project]/app/page.tsx",
      size: 2164,
      compressedSize: 892,
    });
  });

  it("serves routes endpoint", async () => {
    const payload = await loadAnalyzeSession(fixturePath);
    const response = await handleRequest(
      new Request(`http://trace-server/sessions/${payload.sessionId}/routes`),
    );
    expect(response.status).toBe(200);
    const routes = await parseJson(response);
    expect(routes.routes).toEqual([
      {
        route: "/",
        sourceCount: 10,
        outputFileCount: 5,
        chunkPartCount: 10,
        totalSize: 4784,
        totalCompressedSize: 2022,
      },
      {
        route: "/about",
        sourceCount: 5,
        outputFileCount: 3,
        chunkPartCount: 3,
        totalSize: 1340,
        totalCompressedSize: 550,
      },
    ]);
  });

  it("serves modules endpoint", async () => {
    const payload = await loadAnalyzeSession(fixturePath);
    const response = await handleRequest(
      new Request(`http://trace-server/sessions/${payload.sessionId}/modules?route=%2Fabout&limit=3`),
    );
    expect(response.status).toBe(200);
    const modules = await parseJson(response);
    expect(modules.route).toBe("/about");
    expect(modules.totalModules).toBe(10);
    expect(modules.modules).toHaveLength(3);
    expect(modules.modules[0]).toMatchObject({
      index: 3,
      path: "/app/about/page.tsx",
      dependencyCount: 5,
      dependentCount: 0,
    });
  });

  it("serves sizes endpoint", async () => {
    const payload = await loadAnalyzeSession(fixturePath);
    const response = await handleRequest(
      new Request(`http://trace-server/sessions/${payload.sessionId}/sizes?route=%2F`),
    );
    expect(response.status).toBe(200);
    const sizes = await parseJson(response);
    expect(sizes.route).toBe("/");
    expect(sizes.byOutputType).toEqual([
      { type: "js", count: 8, size: 4500, compressedSize: 1880 },
      { type: "css", count: 1, size: 220, compressedSize: 110 },
      { type: "json", count: 1, size: 64, compressedSize: 32 },
    ]);
    expect(sizes.byEnvironment).toEqual([
      { env: "client", count: 5, size: 2770, compressedSize: 1190 },
      { env: "server", count: 4, size: 1950, compressedSize: 800 },
    ]);
    expect(sizes.topOutputFiles[0]).toEqual({
      filename: "[client-fs]/app/page.js",
      size: 2550,
      compressedSize: 1080,
      chunkParts: 4,
    });
  });

  it("returns 404 for devtools-only endpoints on analyze sessions", async () => {
    const payload = await loadAnalyzeSession(fixturePath);
    const response = await handleRequest(
      new Request(`http://trace-server/sessions/${payload.sessionId}/network`),
    );
    expect(response.status).toBe(404);
    const body = await parseJson(response);
    expect(body.error).toBe("Endpoint 'network' is not available for 'next-analyze' sessions");
  });

  it("supports query with route option", async () => {
    const payload = await loadAnalyzeSession(fixturePath);
    const response = await handleRequest(
      new Request(`http://trace-server/sessions/${payload.sessionId}/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: "({ routes, sourceCount: analyze?.sourceCount(), modulePath: modules.module(0)?.path, knownRoutes: [...allAnalyze.keys()] })",
          route: "/about",
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await parseJson(response);
    expect(JSON.parse(body.result)).toEqual({
      routes: ["/", "/about"],
      sourceCount: 5,
      modulePath: "/app/page.tsx",
      knownRoutes: ["/", "/about"],
    });
  });
});
