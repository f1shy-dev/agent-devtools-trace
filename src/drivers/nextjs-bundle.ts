import { createHash } from "crypto";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { basename, extname, join } from "path";
import { DatasetSession } from "../core/dataset-session.js";
import { pretty as prettyValue } from "../core/presentation.js";
import type {
  ReportProvider,
  SourceDetection,
  SourceDriver,
  SourceProbe,
  TableProvider,
} from "../core/types.js";
import type { CapabilityMap, TableColumn } from "../shared/types.js";

interface EdgesDataReference {
  offset: number;
  length: number;
}

interface AnalyzeDataHeader {
  sources: Array<{
    parent_source_index: number | null;
    path: string;
  }>;
  chunk_parts: Array<{
    source_index: number;
    output_file_index: number;
    size: number;
    compressed_size: number;
  }>;
  output_files: Array<{
    filename: string;
  }>;
  output_file_chunk_parts: EdgesDataReference;
  source_chunk_parts: EdgesDataReference;
  source_children: EdgesDataReference;
  source_roots: number[];
}

interface ModulesDataHeader {
  modules: Array<{
    ident: string;
    path: string;
  }>;
  module_dependents: EdgesDataReference;
  async_module_dependents: EdgesDataReference;
  module_dependencies: EdgesDataReference;
  async_module_dependencies: EdgesDataReference;
}

interface ParsedAnalyzeData {
  filePath: string;
  header: AnalyzeDataHeader;
  outputFileChunkParts: number[][];
  sourceChunkParts: number[][];
  sourceChildren: number[][];
}

interface ParsedModulesData {
  filePath: string;
  header: ModulesDataHeader;
  moduleDependents: number[][];
  asyncModuleDependents: number[][];
  moduleDependencies: number[][];
  asyncModuleDependencies: number[][];
}

type SourceNodeInfo = {
  sourceIndex: number;
  path: string;
  segment: string;
  parentIndex: number | null;
  isDirectory: boolean;
  childIndices: number[];
};

type SourceRow = {
  sourceIndex: number;
  path: string;
  segment: string;
  parentIndex: number | null;
  isDirectory: boolean;
  totalSize: number;
  compressedSize: number;
  chunkPartCount: number;
};

type OutputFileRow = {
  fileIndex: number;
  filename: string;
  cleanFilename: string;
  environment: string;
  fileType: string;
  totalSize: number;
  compressedSize: number;
  chunkPartCount: number;
};

type ChunkPartRow = {
  chunkPartIndex: number;
  sourceIndex: number;
  sourcePath: string;
  outputFileIndex: number;
  outputFilename: string;
  size: number;
  compressedSize: number;
};

type ModuleRow = {
  moduleIndex: number;
  ident: string;
  path: string;
  cleanPath: string;
  isNodeModule: boolean;
  packageName: string | null;
  dependencyCount: number;
  asyncDependencyCount: number;
  dependentCount: number;
  asyncDependentCount: number;
};

type RouteRow = {
  route: string;
  hasAnalyzeData: boolean;
};

type SourceTreeRow = SourceRow & {
  outputFileCount: number;
  outputFiles: string;
  environments: string;
};

type ModuleDependencyRow = {
  fromModule: string;
  toModule: string;
  kind: string;
};

type PackageSizeRow = {
  packageName: string;
  totalSize: number;
  compressedSize: number;
  moduleCount: number;
  sourceCount: number;
};

type RouteSizeRow = {
  route: string;
  totalSize: number;
  compressedSize: number;
  sourceCount: number;
  outputFileCount: number;
  chunkPartCount: number;
};

type EnvironmentBreakdownRow = {
  environment: string;
  totalSize: number;
  compressedSize: number;
  fileCount: number;
};

type RouteAnalysis = {
  route: string;
  totalSize: number;
  compressedSize: number;
  sourceCount: number;
  outputFileCount: number;
  chunkPartCount: number;
  sources: SourceRow[];
  outputFiles: OutputFileRow[];
  chunkParts: ChunkPartRow[];
};

function hashFilePath(filePath: string) {
  return createHash("sha256").update(filePath).digest("hex").slice(0, 8);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function toNumber(value: unknown) {
  return isFiniteNumber(value) ? value : 0;
}

function cleanProjectPrefix(value: string) {
  return value.replace(/^\[project\]\//, "");
}

function cleanOutputPrefix(value: string) {
  return value.replace(/^\[output\]\//, "");
}

function normalizeReconstructedPath(value: string) {
  let next = value;
  let previous = "";
  while (next !== previous) {
    previous = next;
    next = next
      .replace(/\[project\]\/\[project\]\//g, "[project]/")
      .replace(/\[output\]\/\[output\]\//g, "[output]/");
  }
  return next;
}

function inferEnvironment(filename: string) {
  return filename.includes("/server/") ? "server" : "client";
}

function inferFileType(filename: string) {
  const extension = extname(filename).toLowerCase();
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return "js";
  if (extension === ".css") return "css";
  if (extension === ".json") return "json";
  return "other";
}

function extractPackageName(pathValue: string): string | null {
  const marker = "node_modules/";
  const markerIndex = pathValue.indexOf(marker);
  if (markerIndex === -1) return null;
  const remainder = pathValue.slice(markerIndex + marker.length);
  const parts = remainder.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]!.startsWith("@") && parts.length >= 2) {
    return `${parts[0]}/${parts[1]}`;
  }
  return parts[0] ?? null;
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function createStaticTable(name: string, description: string, columns: TableColumn[], rows: unknown[]): TableProvider {
  return {
    name,
    description,
    columns,
    async rows() {
      return rows;
    },
  };
}

function createReport(
  name: string,
  description: string,
  run: (_args?: Record<string, unknown>) => Promise<unknown> | unknown,
  pretty?: (args?: Record<string, unknown>) => Promise<string> | string,
): ReportProvider {
  return {
    name,
    description,
    async run(_session, args) {
      return run(args);
    },
    async pretty(_session, args) {
      return pretty ? pretty(args) : prettyValue(await run(args));
    },
  };
}

function parseHeaderEnvelope(buffer: Buffer) {
  if (buffer.length < 4) {
    throw new Error("Invalid Next.js bundle analyzer file: missing header length");
  }
  const headerLength = buffer.readUInt32BE(0);
  const headerStart = 4;
  const headerEnd = headerStart + headerLength;
  if (buffer.length < headerEnd) {
    throw new Error("Invalid Next.js bundle analyzer file: truncated header");
  }
  return {
    headerText: buffer.subarray(headerStart, headerEnd).toString("utf8"),
    binary: buffer.subarray(headerEnd),
  };
}

function parseEdgesSection(binary: Buffer, ref: EdgesDataReference): number[][] {
  const start = ref.offset;
  const end = start + ref.length;
  if (start < 0 || ref.length < 4 || end > binary.length) {
    throw new Error("Invalid Next.js bundle analyzer edge reference");
  }
  const section = binary.subarray(start, end);
  const nodeCount = section.readUInt32BE(0);
  const offsetsByteLength = nodeCount * 4;
  const edgeTargetsStart = 4 + offsetsByteLength;
  if (edgeTargetsStart > section.length) {
    throw new Error("Invalid Next.js bundle analyzer edges section");
  }
  const offsets: number[] = new Array(nodeCount);
  for (let index = 0; index < nodeCount; index += 1) {
    offsets[index] = section.readUInt32BE(4 + index * 4);
  }
  const edgeCount = (section.length - edgeTargetsStart) / 4;
  if (!Number.isInteger(edgeCount)) {
    throw new Error("Invalid Next.js bundle analyzer edge payload");
  }
  const targets: number[] = new Array(edgeCount);
  for (let index = 0; index < edgeCount; index += 1) {
    targets[index] = section.readUInt32BE(edgeTargetsStart + index * 4);
  }
  const edges: number[][] = new Array(nodeCount);
  let previousOffset = 0;
  for (let index = 0; index < nodeCount; index += 1) {
    const currentOffset = offsets[index] ?? previousOffset;
    edges[index] = targets.slice(previousOffset, currentOffset);
    previousOffset = currentOffset;
  }
  return edges;
}

function isAnalyzeDataHeader(value: unknown): value is AnalyzeDataHeader {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.sources) &&
    Array.isArray(value.chunk_parts) &&
    Array.isArray(value.output_files) &&
    isRecord(value.output_file_chunk_parts) &&
    isRecord(value.source_chunk_parts) &&
    isRecord(value.source_children) &&
    Array.isArray(value.source_roots)
  );
}

function isModulesDataHeader(value: unknown): value is ModulesDataHeader {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.modules) &&
    isRecord(value.module_dependents) &&
    isRecord(value.async_module_dependents) &&
    isRecord(value.module_dependencies) &&
    isRecord(value.async_module_dependencies)
  );
}

export async function parseAnalyzeData(filePath: string): Promise<ParsedAnalyzeData> {
  const buffer = await readFile(filePath);
  const { headerText, binary } = parseHeaderEnvelope(buffer);
  const parsed = JSON.parse(headerText);
  if (!isAnalyzeDataHeader(parsed)) {
    throw new Error(`Invalid analyze.data header: ${filePath}`);
  }
  return {
    filePath,
    header: parsed,
    outputFileChunkParts: parseEdgesSection(binary, parsed.output_file_chunk_parts),
    sourceChunkParts: parseEdgesSection(binary, parsed.source_chunk_parts),
    sourceChildren: parseEdgesSection(binary, parsed.source_children),
  };
}

export async function parseModulesData(filePath: string): Promise<ParsedModulesData> {
  const buffer = await readFile(filePath);
  const { headerText, binary } = parseHeaderEnvelope(buffer);
  const parsed = JSON.parse(headerText);
  if (!isModulesDataHeader(parsed)) {
    throw new Error(`Invalid modules.data header: ${filePath}`);
  }
  return {
    filePath,
    header: parsed,
    moduleDependents: parseEdgesSection(binary, parsed.module_dependents),
    asyncModuleDependents: parseEdgesSection(binary, parsed.async_module_dependents),
    moduleDependencies: parseEdgesSection(binary, parsed.module_dependencies),
    asyncModuleDependencies: parseEdgesSection(binary, parsed.async_module_dependencies),
  };
}

export function reconstructSourceTree(header: AnalyzeDataHeader, sourceChildren: number[][]): SourceNodeInfo[] {
  const cache = new Map<number, string>();
  const buildPath = (sourceIndex: number): string => {
    const cached = cache.get(sourceIndex);
    if (cached !== undefined) return cached;
    const source = header.sources[sourceIndex];
    if (!source) return "";
    const fullPath = normalizeReconstructedPath(
      source.parent_source_index == null ? source.path : `${buildPath(source.parent_source_index)}${source.path}`,
    );
    cache.set(sourceIndex, fullPath);
    return fullPath;
  };

  const nodes: SourceNodeInfo[] = header.sources.map((source, sourceIndex) => {
    const childIndices = sourceChildren[sourceIndex] ?? [];
    const rawPath = buildPath(sourceIndex);
    return {
      sourceIndex,
      path: rawPath || (source.parent_source_index == null ? "[root]" : source.path),
      segment: source.path,
      parentIndex: source.parent_source_index,
      isDirectory: source.path.endsWith("/") || childIndices.length > 0 || source.path.length === 0,
      childIndices,
    };
  });

  for (const rootIndex of header.source_roots) {
    buildPath(rootIndex);
  }

  return nodes;
}

function buildAnalyzeTables(parsed: ParsedAnalyzeData) {
  const sourceNodes = reconstructSourceTree(parsed.header, parsed.sourceChildren);
  const directSourceStats = sourceNodes.map(() => ({ totalSize: 0, compressedSize: 0, chunkPartCount: 0 }));
  const outputStats = parsed.header.output_files.map(() => ({ totalSize: 0, compressedSize: 0, chunkPartCount: 0 }));

  const chunkPartRows: ChunkPartRow[] = parsed.header.chunk_parts.map((part, chunkPartIndex) => {
    const sourceNode = sourceNodes[part.source_index];
    const outputFile = parsed.header.output_files[part.output_file_index];
    if (directSourceStats[part.source_index]) {
      directSourceStats[part.source_index]!.totalSize += toNumber(part.size);
      directSourceStats[part.source_index]!.compressedSize += toNumber(part.compressed_size);
      directSourceStats[part.source_index]!.chunkPartCount += 1;
    }
    if (outputStats[part.output_file_index]) {
      outputStats[part.output_file_index]!.totalSize += toNumber(part.size);
      outputStats[part.output_file_index]!.compressedSize += toNumber(part.compressed_size);
      outputStats[part.output_file_index]!.chunkPartCount += 1;
    }
    return {
      chunkPartIndex,
      sourceIndex: part.source_index,
      sourcePath: sourceNode?.path ?? `source:${part.source_index}`,
      outputFileIndex: part.output_file_index,
      outputFilename: outputFile?.filename ?? `output:${part.output_file_index}`,
      size: toNumber(part.size),
      compressedSize: toNumber(part.compressed_size),
    };
  });

  const aggregateCache = new Map<number, { totalSize: number; compressedSize: number; chunkPartCount: number }>();
  const aggregateSource = (sourceIndex: number) => {
    const cached = aggregateCache.get(sourceIndex);
    if (cached) return cached;
    const direct = directSourceStats[sourceIndex] ?? { totalSize: 0, compressedSize: 0, chunkPartCount: 0 };
    let totalSize = direct.totalSize;
    let compressedSize = direct.compressedSize;
    let chunkPartCount = direct.chunkPartCount;
    for (const childIndex of parsed.sourceChildren[sourceIndex] ?? []) {
      const child = aggregateSource(childIndex);
      totalSize += child.totalSize;
      compressedSize += child.compressedSize;
      chunkPartCount += child.chunkPartCount;
    }
    const aggregated = { totalSize, compressedSize, chunkPartCount };
    aggregateCache.set(sourceIndex, aggregated);
    return aggregated;
  };

  const sourceRows: SourceRow[] = sourceNodes.map((node) => {
    const totals = aggregateSource(node.sourceIndex);
    return {
      sourceIndex: node.sourceIndex,
      path: node.path,
      segment: node.segment,
      parentIndex: node.parentIndex,
      isDirectory: node.isDirectory,
      totalSize: totals.totalSize,
      compressedSize: totals.compressedSize,
      chunkPartCount: totals.chunkPartCount,
    };
  });

  const outputFileRows: OutputFileRow[] = parsed.header.output_files.map((file, fileIndex) => {
    const stats = outputStats[fileIndex] ?? { totalSize: 0, compressedSize: 0, chunkPartCount: 0 };
    return {
      fileIndex,
      filename: file.filename,
      cleanFilename: cleanOutputPrefix(file.filename),
      environment: inferEnvironment(file.filename),
      fileType: inferFileType(file.filename),
      totalSize: stats.totalSize,
      compressedSize: stats.compressedSize,
      chunkPartCount: stats.chunkPartCount,
    };
  });

  const leafOutputAgg = new Map<number, { files: Set<string>; environments: Set<string> }>();
  for (const row of chunkPartRows) {
    const outputFile = outputFileRows[row.outputFileIndex];
    const existing = leafOutputAgg.get(row.sourceIndex) ?? {
      files: new Set<string>(),
      environments: new Set<string>(),
    };
    if (outputFile) {
      existing.files.add(outputFile.cleanFilename);
      existing.environments.add(outputFile.environment);
    }
    leafOutputAgg.set(row.sourceIndex, existing);
  }

  const sourceTreeRows: SourceTreeRow[] = sourceRows
    .filter((row) => !row.isDirectory)
    .map((row) => {
      const agg = leafOutputAgg.get(row.sourceIndex) ?? { files: new Set<string>(), environments: new Set<string>() };
      const outputFiles = [...agg.files].sort();
      const environments = [...agg.environments].sort();
      return {
        ...row,
        outputFileCount: outputFiles.length,
        outputFiles: outputFiles.join(", "),
        environments: environments.join(", "),
      };
    });

  return {
    sourceRows,
    outputFileRows,
    chunkPartRows,
    sourceTreeRows,
  };
}

async function readRoutesFile(filePath: string): Promise<string[]> {
  try {
    const payload = JSON.parse(await readFile(filePath, "utf8"));
    return Array.isArray(payload) ? payload.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function routeToAnalyzePath(rootDir: string, route: string) {
  if (route === "/") return join(rootDir, "analyze.data");
  const relativeRoute = route.replace(/^\//, "");
  return join(rootDir, relativeRoute, "analyze.data");
}

async function buildRouteAnalyses(rootDir: string, routes: RouteRow[]): Promise<RouteAnalysis[]> {
  const analyses: RouteAnalysis[] = [];
  for (const routeRow of routes) {
    if (!routeRow.hasAnalyzeData) continue;
    const parsed = await parseAnalyzeData(routeToAnalyzePath(rootDir, routeRow.route));
    const tables = buildAnalyzeTables(parsed);
    analyses.push({
      route: routeRow.route,
      totalSize: tables.chunkPartRows.reduce((sum, row) => sum + row.size, 0),
      compressedSize: tables.chunkPartRows.reduce((sum, row) => sum + row.compressedSize, 0),
      sourceCount: tables.sourceRows.length,
      outputFileCount: tables.outputFileRows.length,
      chunkPartCount: tables.chunkPartRows.length,
      sources: tables.sourceRows,
      outputFiles: tables.outputFileRows,
      chunkParts: tables.chunkPartRows,
    });
  }
  return analyses.sort((left, right) => left.route.localeCompare(right.route));
}

export class NextjsBundleDriver implements SourceDriver {
  id = "nextjs-bundle";

  async detect(source: SourceProbe): Promise<SourceDetection | null> {
    if (!source.isDirectory) return null;
    const analyzePath = join(source.path, "analyze.data");
    if (!existsSync(analyzePath)) return null;
    try {
      const buffer = await readFile(analyzePath);
      if (buffer.length < 8) return null;
      const headerLength = buffer.readUInt32BE(0);
      if (headerLength <= 0 || buffer.length < 4 + headerLength) return null;
      const headerText = buffer.subarray(4, 4 + headerLength).toString("utf8");
      if (!headerText.startsWith('{"sources":')) return null;
      const parsed = JSON.parse(headerText);
      return isAnalyzeDataHeader(parsed)
        ? { kind: "nextjs-bundle", driverId: this.id }
        : null;
    } catch {
      return null;
    }
  }

  async open(sourcePath: string, detection: SourceDetection) {
    const analyzePath = join(sourcePath, "analyze.data");
    const modulesPath = join(sourcePath, "modules.data");
    const routesPath = join(sourcePath, "routes.json");

    const analyze = await parseAnalyzeData(analyzePath);
    const analyzeTables = buildAnalyzeTables(analyze);
    const routesList = await readRoutesFile(routesPath);
    const routeRows: RouteRow[] = routesList.map((route) => ({
      route,
      hasAnalyzeData: existsSync(routeToAnalyzePath(sourcePath, route)),
    }));

    const modules = existsSync(modulesPath) ? await parseModulesData(modulesPath) : null;
    const moduleRows: ModuleRow[] = modules
      ? modules.header.modules.map((module, moduleIndex) => {
          const cleanPath = cleanProjectPrefix(module.path);
          const isNodeModule = cleanPath.includes("node_modules/");
          return {
            moduleIndex,
            ident: module.ident,
            path: module.path,
            cleanPath,
            isNodeModule,
            packageName: isNodeModule ? extractPackageName(cleanPath) : null,
            dependencyCount: (modules.moduleDependencies[moduleIndex] ?? []).length,
            asyncDependencyCount: (modules.asyncModuleDependencies[moduleIndex] ?? []).length,
            dependentCount: (modules.moduleDependents[moduleIndex] ?? []).length,
            asyncDependentCount: (modules.asyncModuleDependents[moduleIndex] ?? []).length,
          };
        })
      : [];

    const moduleDependencyRows: ModuleDependencyRow[] = [];
    if (modules) {
      modules.header.modules.forEach((module, moduleIndex) => {
        for (const targetIndex of modules.moduleDependencies[moduleIndex] ?? []) {
          const target = modules.header.modules[targetIndex];
          if (!target) continue;
          moduleDependencyRows.push({
            fromModule: module.path,
            toModule: target.path,
            kind: "sync",
          });
        }
        for (const targetIndex of modules.asyncModuleDependencies[moduleIndex] ?? []) {
          const target = modules.header.modules[targetIndex];
          if (!target) continue;
          moduleDependencyRows.push({
            fromModule: module.path,
            toModule: target.path,
            kind: "async",
          });
        }
      });
    }

    const leafSourcePackageAgg = new Map<
      string,
      { packageName: string; totalSize: number; compressedSize: number; sourceCount: number; moduleCount: number }
    >();
    for (const row of analyzeTables.sourceTreeRows) {
      const packageName = extractPackageName(cleanProjectPrefix(row.path));
      if (!packageName) continue;
      const existing = leafSourcePackageAgg.get(packageName) ?? {
        packageName,
        totalSize: 0,
        compressedSize: 0,
        sourceCount: 0,
        moduleCount: 0,
      };
      existing.totalSize += row.totalSize;
      existing.compressedSize += row.compressedSize;
      existing.sourceCount += 1;
      leafSourcePackageAgg.set(packageName, existing);
    }
    for (const row of moduleRows) {
      if (!row.packageName) continue;
      const existing = leafSourcePackageAgg.get(row.packageName) ?? {
        packageName: row.packageName,
        totalSize: 0,
        compressedSize: 0,
        sourceCount: 0,
        moduleCount: 0,
      };
      existing.moduleCount += 1;
      leafSourcePackageAgg.set(row.packageName, existing);
    }
    const packageSizeRows: PackageSizeRow[] = [...leafSourcePackageAgg.values()]
      .map((entry) => ({
        packageName: entry.packageName,
        totalSize: entry.totalSize,
        compressedSize: entry.compressedSize,
        moduleCount: entry.moduleCount,
        sourceCount: entry.sourceCount,
      }))
      .sort((left, right) => right.totalSize - left.totalSize || left.packageName.localeCompare(right.packageName));

    const environmentBreakdownMap = new Map<string, EnvironmentBreakdownRow>();
    for (const row of analyzeTables.outputFileRows) {
      const existing = environmentBreakdownMap.get(row.environment) ?? {
        environment: row.environment,
        totalSize: 0,
        compressedSize: 0,
        fileCount: 0,
      };
      existing.totalSize += row.totalSize;
      existing.compressedSize += row.compressedSize;
      existing.fileCount += 1;
      environmentBreakdownMap.set(row.environment, existing);
    }
    const environmentBreakdownRows: EnvironmentBreakdownRow[] = [...environmentBreakdownMap.values()].sort((a, b) =>
      a.environment.localeCompare(b.environment),
    );

    const syncEdgeCount = moduleDependencyRows.filter((row) => row.kind === "sync").length;
    const asyncEdgeCount = moduleDependencyRows.filter((row) => row.kind === "async").length;
    const mostDependedOnModule = [...moduleRows].sort(
      (left, right) => right.dependentCount - left.dependentCount || left.path.localeCompare(right.path),
    )[0] ?? null;

    const capabilities: CapabilityMap = {
      bundleAnalyzer: true,
      tool: "nextjs-turbopack",
      hasModuleGraph: Boolean(modules),
      hasRoutes: routeRows.length > 0,
      routeCount: routeRows.length,
      totalSources: analyzeTables.sourceRows.length,
      totalModules: moduleRows.length,
      totalOutputFiles: analyzeTables.outputFileRows.length,
    };

    const session = new DatasetSession({
      sourcePath,
      detection,
      itemCount: analyzeTables.chunkPartRows.length,
      rawDocument: async () => ({
        analyze: analyze.header,
        modules: modules?.header ?? null,
        routes: routesList,
      }),
      capabilities: async () => capabilities,
    });

    session.registerRawRows("nextbundle.analyze", async () => [analyze.header]);
    session.registerRawRows("nextbundle.modules", async () => (modules ? [modules.header] : []));
    session.registerRawRows("nextbundle.routes", async () => routeRows);

    session.layers.register({
      key: "nextbundle/route-analyses",
      weight: "heavy",
      evictable: true,
      build: async () => buildRouteAnalyses(sourcePath, routeRows),
    });

    const sourceColumns: TableColumn[] = [
      { name: "sourceIndex", type: "number", description: "Index in the sources array" },
      { name: "path", type: "string", description: "Full reconstructed source path" },
      { name: "segment", type: "string", description: "This node's path segment" },
      { name: "parentIndex", type: "number", description: "Parent source index" },
      { name: "isDirectory", type: "boolean", description: "Whether this node is a directory" },
      { name: "totalSize", type: "number", unit: "bytes", description: "Aggregate source size" },
      { name: "compressedSize", type: "number", unit: "bytes", description: "Aggregate compressed size" },
      { name: "chunkPartCount", type: "number", description: "Number of chunk parts for this source subtree" },
    ];
    const outputFileColumns: TableColumn[] = [
      { name: "fileIndex", type: "number", description: "Index in output_files array" },
      { name: "filename", type: "string", description: "Full output filename" },
      { name: "cleanFilename", type: "string", description: "Filename with [output]/ stripped" },
      { name: "environment", type: "string", description: "server or client" },
      { name: "fileType", type: "string", description: "js, css, json, or other" },
      { name: "totalSize", type: "number", unit: "bytes", description: "Aggregate output size" },
      { name: "compressedSize", type: "number", unit: "bytes", description: "Aggregate compressed size" },
      { name: "chunkPartCount", type: "number", description: "Number of chunk parts" },
    ];
    const chunkPartColumns: TableColumn[] = [
      { name: "chunkPartIndex", type: "number", description: "Chunk part index" },
      { name: "sourceIndex", type: "number", description: "Source index" },
      { name: "sourcePath", type: "string", description: "Full source path" },
      { name: "outputFileIndex", type: "number", description: "Output file index" },
      { name: "outputFilename", type: "string", description: "Output filename" },
      { name: "size", type: "number", unit: "bytes", description: "Uncompressed size" },
      { name: "compressedSize", type: "number", unit: "bytes", description: "Compressed size" },
    ];
    const moduleColumns: TableColumn[] = [
      { name: "moduleIndex", type: "number", description: "Module index" },
      { name: "ident", type: "string", description: "Full module identifier" },
      { name: "path", type: "string", description: "Full clean module path" },
      { name: "cleanPath", type: "string", description: "Path with [project]/ stripped" },
      { name: "isNodeModule", type: "boolean", description: "Whether the module comes from node_modules" },
      { name: "packageName", type: "string", description: "NPM package name" },
      { name: "dependencyCount", type: "number", description: "Sync dependency count" },
      { name: "asyncDependencyCount", type: "number", description: "Async dependency count" },
      { name: "dependentCount", type: "number", description: "Sync dependent count" },
      { name: "asyncDependentCount", type: "number", description: "Async dependent count" },
    ];
    const routeColumns: TableColumn[] = [
      { name: "route", type: "string", description: "Route path" },
      { name: "hasAnalyzeData", type: "boolean", description: "Whether per-route analyze.data exists" },
    ];
    const sourceTreeColumns: TableColumn[] = [
      ...sourceColumns,
      { name: "outputFileCount", type: "number", description: "Number of output files containing this source" },
      { name: "outputFiles", type: "string", description: "Comma-separated output files" },
      { name: "environments", type: "string", description: "Comma-separated environments" },
    ];
    const moduleDependencyColumns: TableColumn[] = [
      { name: "fromModule", type: "string", description: "Source module path" },
      { name: "toModule", type: "string", description: "Target module path" },
      { name: "kind", type: "string", description: "sync or async" },
    ];
    const packageSizeColumns: TableColumn[] = [
      { name: "packageName", type: "string", description: "NPM package name" },
      { name: "totalSize", type: "number", unit: "bytes", description: "Aggregate source size" },
      { name: "compressedSize", type: "number", unit: "bytes", description: "Aggregate compressed size" },
      { name: "moduleCount", type: "number", description: "Number of matching modules" },
      { name: "sourceCount", type: "number", description: "Number of matching sources" },
    ];
    const routeSizeColumns: TableColumn[] = [
      { name: "route", type: "string", description: "Route path" },
      { name: "totalSize", type: "number", unit: "bytes", description: "Total uncompressed size" },
      { name: "compressedSize", type: "number", unit: "bytes", description: "Total compressed size" },
      { name: "sourceCount", type: "number", description: "Sources in this route" },
      { name: "outputFileCount", type: "number", description: "Output files in this route" },
      { name: "chunkPartCount", type: "number", description: "Chunk parts in this route" },
    ];
    const environmentBreakdownColumns: TableColumn[] = [
      { name: "environment", type: "string", description: "server or client" },
      { name: "totalSize", type: "number", unit: "bytes", description: "Total size" },
      { name: "compressedSize", type: "number", unit: "bytes", description: "Compressed size" },
      { name: "fileCount", type: "number", description: "Output file count" },
    ];

    session.registerTable(
      createStaticTable("nextbundle.dims.sources", "Next.js analyzed source tree nodes", sourceColumns, analyzeTables.sourceRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.dims.outputFiles", "Next.js analyzed output files", outputFileColumns, analyzeTables.outputFileRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.dims.chunkParts", "Source-to-output-file chunk part mappings", chunkPartColumns, analyzeTables.chunkPartRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.dims.modules", "Next.js module graph rows from modules.data", moduleColumns, moduleRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.dims.routes", "Next.js route manifest rows", routeColumns, routeRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.views.sourceTree", "Leaf sources enriched with output file details", sourceTreeColumns, analyzeTables.sourceTreeRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.views.moduleDependencies", "Flattened module dependency edges", moduleDependencyColumns, moduleDependencyRows),
    );
    session.registerTable(
      createStaticTable("nextbundle.views.packageSizes", "Package aggregation across sources and modules", packageSizeColumns, packageSizeRows),
    );
    session.registerTable({
      name: "nextbundle.views.routeSizes",
      description: "Per-route bundle sizes derived from per-route analyze.data files",
      columns: routeSizeColumns,
      async rows(session) {
        const analyses = await session.layers.get<RouteAnalysis[]>("nextbundle/route-analyses");
        return analyses.map((entry) => ({
          route: entry.route,
          totalSize: entry.totalSize,
          compressedSize: entry.compressedSize,
          sourceCount: entry.sourceCount,
          outputFileCount: entry.outputFileCount,
          chunkPartCount: entry.chunkPartCount,
        }));
      },
    });
    session.registerTable(
      createStaticTable(
        "nextbundle.views.environmentBreakdown",
        "Server versus client output breakdown",
        environmentBreakdownColumns,
        environmentBreakdownRows,
      ),
    );

    const topSources = [...analyzeTables.sourceTreeRows]
      .sort((left, right) => right.totalSize - left.totalSize || left.path.localeCompare(right.path))
      .slice(0, 10);
    const topPackagesByModuleCount = [...packageSizeRows]
      .sort((left, right) => right.moduleCount - left.moduleCount || left.packageName.localeCompare(right.packageName))
      .slice(0, 10);

    session.registerReport(
      createReport(
        "nextbundle.summary",
        "High-level Next.js Turbopack bundle analyzer summary",
        async () => ({
          routes: routeRows,
          totalSources: analyzeTables.sourceRows.length,
          totalOutputFiles: analyzeTables.outputFileRows.length,
          totalChunkParts: analyzeTables.chunkPartRows.length,
          totalModules: moduleRows.length,
          environmentBreakdown: environmentBreakdownRows,
          topSources,
          topPackagesByModuleCount,
          moduleDependencyStats: {
            syncEdgeCount,
            asyncEdgeCount,
            mostDependedOnModule: mostDependedOnModule?.path ?? null,
          },
        }),
        async () =>
          [
            "Next.js Bundle Analysis",
            "═══════════════════════",
            `Routes: ${routeRows.length}${routeRows.length > 0 ? ` (${routeRows.map((row) => row.route).join(", ")})` : ""}`,
            `Total sources: ${analyzeTables.sourceRows.length}`,
            `Total output files: ${analyzeTables.outputFileRows.length}`,
            `Total chunk parts: ${analyzeTables.chunkPartRows.length}`,
            `Modules: ${moduleRows.length}`,
            "",
            "Environment breakdown:",
            ...environmentBreakdownRows.map(
              (row) =>
                `  ${row.environment[0]!.toUpperCase()}${row.environment.slice(1)}: ${formatBytes(row.totalSize)} (${formatBytes(row.compressedSize)} compressed) — ${row.fileCount} files`,
            ),
            "",
            "Top 10 sources by size:",
            ...topSources.map(
              (row, index) => `  ${index + 1}. ${row.path} — ${formatBytes(row.totalSize)}`,
            ),
            "",
            "Top 10 packages by module count:",
            ...topPackagesByModuleCount.map(
              (row, index) => `  ${index + 1}. ${row.packageName} — ${row.moduleCount} modules`,
            ),
            "",
            "Module dependency stats:",
            `  Total sync edges: ${syncEdgeCount}`,
            `  Total async edges: ${asyncEdgeCount}`,
            `  Most depended-on module: ${mostDependedOnModule?.path ?? "n/a"}`,
          ].join("\n"),
      ),
    );

    session.registerReport(
      createReport(
        "nextbundle.route",
        "Per-route Next.js bundle detail report",
        async (args) => {
          const route = typeof args?.route === "string" && args.route.length > 0 ? args.route : "/";
          const analyses = await session.layers.get<RouteAnalysis[]>("nextbundle/route-analyses");
          const analysis = analyses.find((entry) => entry.route === route) ?? null;
          return {
            route,
            availableRoutes: routeRows,
            analysis,
          };
        },
        async (args) => {
          const route = typeof args?.route === "string" && args.route.length > 0 ? args.route : "/";
          const analyses = await session.layers.get<RouteAnalysis[]>("nextbundle/route-analyses");
          const analysis = analyses.find((entry) => entry.route === route);
          if (!analysis) {
            return [
              `Next.js route analysis: ${route}`,
              `No analyze.data available for this route.`,
              `Available routes: ${routeRows.map((row) => row.route).join(", ") || "none"}`,
            ].join("\n");
          }
          const topRouteSources = [...analysis.sources]
            .filter((row) => !row.isDirectory)
            .sort((left, right) => right.totalSize - left.totalSize || left.path.localeCompare(right.path))
            .slice(0, 10);
          const topRouteOutputs = [...analysis.outputFiles]
            .sort((left, right) => right.totalSize - left.totalSize || left.filename.localeCompare(right.filename))
            .slice(0, 10);
          return [
            `Next.js route analysis: ${route}`,
            `Total size: ${formatBytes(analysis.totalSize)}`,
            `Compressed size: ${formatBytes(analysis.compressedSize)}`,
            `Sources: ${analysis.sourceCount}`,
            `Output files: ${analysis.outputFileCount}`,
            `Chunk parts: ${analysis.chunkPartCount}`,
            "",
            "Top sources:",
            ...topRouteSources.map((row, index) => `  ${index + 1}. ${row.path} — ${formatBytes(row.totalSize)}`),
            "",
            "Top output files:",
            ...topRouteOutputs.map((row, index) => `  ${index + 1}. ${row.cleanFilename} — ${formatBytes(row.totalSize)}`),
          ].join("\n");
        },
      ),
    );

    session.registerNamespace("nextbundle", {
      report: {
        summary: async () => session.getReport("nextbundle.summary")!.run(session),
        route: async (args) => session.getReport("nextbundle.route")!.run(session, args as Record<string, unknown>),
      },
      sources: async () => session.queryTable("nextbundle.dims.sources"),
      modules: async () => session.queryTable("nextbundle.dims.modules"),
      outputFiles: async () => session.queryTable("nextbundle.dims.outputFiles"),
      routes: async () => session.queryTable("nextbundle.dims.routes"),
    });

    session.setId(hashFilePath(sourcePath));
    return session;
  }
}
