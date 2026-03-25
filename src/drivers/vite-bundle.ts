import { createHash } from "crypto";
import { basename, dirname, extname } from "path";
import { DatasetSession } from "../core/dataset-session.js";
import { pretty as prettyValue } from "../core/presentation.js";
import { readMaybeGzipText } from "../core/io.js";
import type {
  ReportProvider,
  SourceDetection,
  SourceDriver,
  SourceProbe,
  TableProvider,
} from "../core/types.js";
import type { CapabilityMap, TableColumn } from "../shared/types.js";

interface ViteBundleTreeNode {
  label: string;
  filename?: string;
  parsedSize?: number;
  mapSize?: number;
  gzipSize?: number;
  brotliSize?: number;
  source?: ViteBundleTreeNode[];
  imports?: string[];
  isEntry?: boolean;
  isAsset?: boolean;
  groups?: ViteBundleTreeNode[];
}

type ViteBundleChunk = ViteBundleTreeNode & {
  filename: string;
  source: ViteBundleTreeNode[];
  imports: string[];
  isEntry: boolean;
};

type ViteChunkRow = {
  chunkId: string;
  filename: string;
  label: string;
  isEntry: boolean;
  isAsset: boolean;
  parsedSize: number;
  gzipSize: number;
  brotliSize: number;
  mapSize: number;
  importCount: number;
  moduleCount: number;
};

type ViteModuleRow = {
  moduleId: string;
  chunkId: string;
  path: string;
  directory: string | null;
  basename: string;
  parsedSize: number;
  gzipSize: number;
  brotliSize: number;
  isNodeModule: boolean;
  packageName: string | null;
  depth: number;
};

type VitePackageRow = {
  packageName: string;
  parsedSize: number;
  gzipSize: number;
  brotliSize: number;
  moduleCount: number;
  chunkCount: number;
  chunks: string;
};

type ViteChunkImportRow = {
  fromChunk: string;
  toChunk: string;
};

type ViteTreemapRow = {
  chunkId: string;
  path: string;
  label: string;
  parsedSize: number;
  gzipSize: number;
  brotliSize: number;
  isLeaf: boolean;
  childCount: number;
  depth: number;
};

type ViteDuplicateModuleRow = {
  path: string;
  chunkCount: number;
  chunks: string;
  totalParsedSize: number;
};

const VITE_REQUIRED_KEYS = [
  "filename",
  "label",
  "parsedSize",
  "gzipSize",
  "brotliSize",
  "mapSize",
  "source",
  "isEntry",
  "imports",
] as const;

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

function isViteBundleChunk(value: unknown): value is ViteBundleChunk {
  if (!isRecord(value)) return false;
  for (const key of VITE_REQUIRED_KEYS) {
    if (!(key in value)) return false;
  }
  return (
    typeof value.filename === "string" &&
    typeof value.label === "string" &&
    isFiniteNumber(value.parsedSize) &&
    isFiniteNumber(value.gzipSize) &&
    isFiniteNumber(value.brotliSize) &&
    isFiniteNumber(value.mapSize) &&
    typeof value.isEntry === "boolean" &&
    Array.isArray(value.source) &&
    Array.isArray(value.imports)
  );
}

async function parseViteBundle(filePath: string): Promise<ViteBundleChunk[]> {
  const payload = JSON.parse(await readMaybeGzipText(filePath));
  if (!Array.isArray(payload) || payload.length === 0 || !isViteBundleChunk(payload[0])) {
    throw new Error("Invalid vite-bundle-analyzer dataset: expected a chunk array");
  }
  return payload as ViteBundleChunk[];
}

function normalizeDirectory(value: string) {
  if (value === "." || value.length === 0) return null;
  return value;
}

function pathDepth(value: string) {
  return value.split("/").filter(Boolean).length;
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

function inferIsAsset(filename: string) {
  const extension = extname(filename).toLowerCase();
  return ![".js", ".mjs", ".cjs"].includes(extension);
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
  run: () => Promise<unknown> | unknown,
  pretty?: () => Promise<string> | string,
): ReportProvider {
  return {
    name,
    description,
    async run() {
      return run();
    },
    async pretty() {
      return pretty ? pretty() : prettyValue(await run());
    },
  };
}

export class ViteBundleDriver implements SourceDriver {
  id = "vite-bundle";

  async detect(source: SourceProbe): Promise<SourceDetection | null> {
    if (source.isDirectory) return null;
    if (!source.path.endsWith(".json") && !source.path.endsWith(".json.gz") && !source.path.endsWith(".gz")) {
      return null;
    }
    try {
      const payload = JSON.parse(await readMaybeGzipText(source.path));
      if (!Array.isArray(payload) || payload.length === 0) return null;
      return isViteBundleChunk(payload[0])
        ? { kind: "vite-bundle", driverId: this.id }
        : null;
    } catch {
      return null;
    }
  }

  async open(sourcePath: string, detection: SourceDetection) {
    const chunks = await parseViteBundle(sourcePath);
    const chunkRows: ViteChunkRow[] = [];
    const moduleRows: ViteModuleRow[] = [];
    const packageAgg = new Map<
      string,
      {
        packageName: string;
        parsedSize: number;
        gzipSize: number;
        brotliSize: number;
        moduleCount: number;
        chunks: Set<string>;
      }
    >();
    const chunkImportRows: ViteChunkImportRow[] = [];
    const treemapRows: ViteTreemapRow[] = [];

    for (const chunk of chunks) {
      const chunkId = chunk.filename;
      let moduleCount = 0;

      const visitNode = (node: ViteBundleTreeNode, depth: number) => {
        const groups = Array.isArray(node.groups) ? node.groups : [];
        const path =
          typeof node.filename === "string" && node.filename.length > 0
            ? node.filename
            : depth === 0
              ? node.label
              : `${node.label}`;
        const isLeaf = groups.length === 0;
        treemapRows.push({
          chunkId,
          path,
          label: node.label,
          parsedSize: toNumber(node.parsedSize),
          gzipSize: toNumber(node.gzipSize),
          brotliSize: toNumber(node.brotliSize),
          isLeaf,
          childCount: groups.length,
          depth,
        });

        if (isLeaf) {
          moduleCount += 1;
          const modulePath = path;
          const directory = normalizeDirectory(dirname(modulePath));
          const isNodeModule = modulePath.includes("node_modules/");
          const packageName = isNodeModule ? extractPackageName(modulePath) : null;
          moduleRows.push({
            moduleId: `${chunkId}::${modulePath}`,
            chunkId,
            path: modulePath,
            directory,
            basename: basename(modulePath),
            parsedSize: toNumber(node.parsedSize),
            gzipSize: toNumber(node.gzipSize),
            brotliSize: toNumber(node.brotliSize),
            isNodeModule,
            packageName,
            depth: directory ? pathDepth(directory) : 0,
          });
          if (packageName) {
            const existing = packageAgg.get(packageName) ?? {
              packageName,
              parsedSize: 0,
              gzipSize: 0,
              brotliSize: 0,
              moduleCount: 0,
              chunks: new Set<string>(),
            };
            existing.parsedSize += toNumber(node.parsedSize);
            existing.gzipSize += toNumber(node.gzipSize);
            existing.brotliSize += toNumber(node.brotliSize);
            existing.moduleCount += 1;
            existing.chunks.add(chunkId);
            packageAgg.set(packageName, existing);
          }
        }

        for (const child of groups) {
          visitNode(child, depth + 1);
        }
      };

      for (const sourceNode of chunk.source ?? []) {
        visitNode(sourceNode, 0);
      }

      for (const importedChunk of chunk.imports ?? []) {
        chunkImportRows.push({ fromChunk: chunkId, toChunk: importedChunk });
      }

      chunkRows.push({
        chunkId,
        filename: chunk.filename,
        label: chunk.label,
        isEntry: Boolean(chunk.isEntry),
        isAsset: inferIsAsset(chunk.filename),
        parsedSize: toNumber(chunk.parsedSize),
        gzipSize: toNumber(chunk.gzipSize),
        brotliSize: toNumber(chunk.brotliSize),
        mapSize: toNumber(chunk.mapSize),
        importCount: (chunk.imports ?? []).length,
        moduleCount,
      });
    }

    const packageRows: VitePackageRow[] = [...packageAgg.values()]
      .map((entry) => {
        const sortedChunks = [...entry.chunks].sort();
        return {
          packageName: entry.packageName,
          parsedSize: entry.parsedSize,
          gzipSize: entry.gzipSize,
          brotliSize: entry.brotliSize,
          moduleCount: entry.moduleCount,
          chunkCount: sortedChunks.length,
          chunks: sortedChunks.join(", "),
        };
      })
      .sort((left, right) => right.parsedSize - left.parsedSize || left.packageName.localeCompare(right.packageName));

    const largestModules = [...moduleRows]
      .sort((left, right) => right.parsedSize - left.parsedSize || left.path.localeCompare(right.path))
      .slice(0, 100);

    const duplicateModules = new Map<
      string,
      { path: string; totalParsedSize: number; chunks: Set<string> }
    >();
    for (const row of moduleRows) {
      const existing = duplicateModules.get(row.path) ?? {
        path: row.path,
        totalParsedSize: 0,
        chunks: new Set<string>(),
      };
      existing.totalParsedSize += row.parsedSize;
      existing.chunks.add(row.chunkId);
      duplicateModules.set(row.path, existing);
    }
    const duplicateModuleRows: ViteDuplicateModuleRow[] = [...duplicateModules.values()]
      .filter((entry) => entry.chunks.size > 1)
      .map((entry) => {
        const chunksList = [...entry.chunks].sort();
        return {
          path: entry.path,
          chunkCount: chunksList.length,
          chunks: chunksList.join(", "),
          totalParsedSize: entry.totalParsedSize,
        };
      })
      .sort(
        (left, right) =>
          right.chunkCount - left.chunkCount ||
          right.totalParsedSize - left.totalParsedSize ||
          left.path.localeCompare(right.path),
      );

    const totalParsedSize = chunkRows.reduce((sum, row) => sum + row.parsedSize, 0);
    const totalGzipSize = chunkRows.reduce((sum, row) => sum + row.gzipSize, 0);
    const totalBrotliSize = chunkRows.reduce((sum, row) => sum + row.brotliSize, 0);
    const entryChunks = chunkRows.filter((row) => row.isEntry).length;
    const assetChunks = chunkRows.filter((row) => row.isAsset).length;
    const capabilities: CapabilityMap = {
      bundleAnalyzer: true,
      tool: "vite-bundle-analyzer",
      totalChunks: chunkRows.length,
      totalModules: moduleRows.length,
      hasGzipSizes: true,
      hasBrotliSizes: true,
      hasSourceMaps: chunkRows.some((row) => row.mapSize > 0),
      entryChunks,
    };

    const session = new DatasetSession({
      sourcePath,
      detection,
      itemCount: chunks.length,
      rawDocument: async () => chunks,
      capabilities: async () => capabilities,
    });

    session.registerRawRows("bundle.document", async () => chunks);

    const chunkColumns: TableColumn[] = [
      { name: "chunkId", type: "string", description: "filename-based chunk identifier" },
      { name: "filename", type: "string", description: "Output filename" },
      { name: "label", type: "string", description: "Display label" },
      { name: "isEntry", type: "boolean", description: "Whether this is an entry chunk" },
      { name: "isAsset", type: "boolean", description: "Whether this is a non-JS asset" },
      { name: "parsedSize", type: "number", unit: "bytes", description: "Stat/parsed size" },
      { name: "gzipSize", type: "number", unit: "bytes", description: "Gzip size" },
      { name: "brotliSize", type: "number", unit: "bytes", description: "Brotli size" },
      { name: "mapSize", type: "number", unit: "bytes", description: "Source map size" },
      { name: "importCount", type: "number", description: "Number of chunk imports" },
      { name: "moduleCount", type: "number", description: "Number of leaf source modules" },
    ];
    const moduleColumns: TableColumn[] = [
      { name: "moduleId", type: "string", description: "Stable module row identifier" },
      { name: "chunkId", type: "string", description: "Parent chunk filename" },
      { name: "path", type: "string", description: "Full module path" },
      { name: "directory", type: "string", description: "Parent directory" },
      { name: "basename", type: "string", description: "Filename only" },
      { name: "parsedSize", type: "number", unit: "bytes", description: "Stat/parsed size" },
      { name: "gzipSize", type: "number", unit: "bytes", description: "Gzip size" },
      { name: "brotliSize", type: "number", unit: "bytes", description: "Brotli size" },
      { name: "isNodeModule", type: "boolean", description: "Whether the module is under node_modules" },
      { name: "packageName", type: "string", description: "NPM package name for node_modules modules" },
      { name: "depth", type: "number", description: "Directory nesting depth" },
    ];
    const packageColumns: TableColumn[] = [
      { name: "packageName", type: "string", description: "npm package name" },
      { name: "parsedSize", type: "number", unit: "bytes", description: "Total parsed size" },
      { name: "gzipSize", type: "number", unit: "bytes", description: "Total gzip size" },
      { name: "brotliSize", type: "number", unit: "bytes", description: "Total brotli size" },
      { name: "moduleCount", type: "number", description: "Number of modules from this package" },
      { name: "chunkCount", type: "number", description: "Number of chunks containing this package" },
      { name: "chunks", type: "string", description: "Comma-separated chunk filenames" },
    ];
    const chunkImportColumns: TableColumn[] = [
      { name: "fromChunk", type: "string", description: "Importing chunk filename" },
      { name: "toChunk", type: "string", description: "Imported chunk filename" },
    ];
    const treemapColumns: TableColumn[] = [
      { name: "chunkId", type: "string", description: "Parent chunk" },
      { name: "path", type: "string", description: "Full tree path" },
      { name: "label", type: "string", description: "Display label" },
      { name: "parsedSize", type: "number", unit: "bytes", description: "Aggregated parsed size" },
      { name: "gzipSize", type: "number", unit: "bytes", description: "Aggregated gzip size" },
      { name: "brotliSize", type: "number", unit: "bytes", description: "Aggregated brotli size" },
      { name: "isLeaf", type: "boolean", description: "Whether this node is a leaf module" },
      { name: "childCount", type: "number", description: "Number of direct children" },
      { name: "depth", type: "number", description: "Tree depth" },
    ];
    const duplicateColumns: TableColumn[] = [
      { name: "path", type: "string", description: "Module path" },
      { name: "chunkCount", type: "number", description: "Number of chunks containing this module" },
      { name: "chunks", type: "string", description: "Comma-separated chunk filenames" },
      { name: "totalParsedSize", type: "number", unit: "bytes", description: "Total duplicate parsed size" },
    ];

    session.registerTable(
      createStaticTable("bundle.dims.chunks", "Output chunks and assets from vite-bundle-analyzer", chunkColumns, chunkRows),
    );
    session.registerTable(
      createStaticTable("bundle.dims.modules", "Leaf source modules flattened from the bundle source tree", moduleColumns, moduleRows),
    );
    session.registerTable(
      createStaticTable("bundle.dims.packages", "Package-level aggregation across bundled source modules", packageColumns, packageRows),
    );
    session.registerTable(
      createStaticTable("bundle.dims.chunkImports", "Chunk-to-chunk import edges", chunkImportColumns, chunkImportRows),
    );
    session.registerTable(
      createStaticTable("bundle.views.treemap", "Flattened hierarchical source tree for treemap-style queries", treemapColumns, treemapRows),
    );
    session.registerTable(
      createStaticTable("bundle.views.largestModules", "Top modules by parsed size", moduleColumns, largestModules),
    );
    session.registerTable(
      createStaticTable("bundle.views.duplicateModules", "Modules that appear in multiple chunks", duplicateColumns, duplicateModuleRows),
    );

    const topChunks = [...chunkRows]
      .sort((left, right) => right.parsedSize - left.parsedSize || left.filename.localeCompare(right.filename))
      .slice(0, 5);
    const topPackages = packageRows.slice(0, 5);
    const topModules = largestModules.slice(0, 5);

    session.registerReport(
      createReport(
        "bundle.summary",
        "High-level vite bundle analyzer summary",
        async () => ({
          totals: {
            chunks: chunkRows.length,
            entryChunks,
            assetChunks,
            parsedSize: totalParsedSize,
            gzipSize: totalGzipSize,
            brotliSize: totalBrotliSize,
          },
          topChunks,
          topPackages,
          topModules,
        }),
        async () =>
          [
            "Bundle Summary",
            "══════════════",
            `Total chunks: ${chunkRows.length}`,
            `  Entry chunks: ${entryChunks}`,
            `  Asset chunks: ${assetChunks}`,
            `Total parsed size: ${formatBytes(totalParsedSize)}`,
            `Total gzip size: ${formatBytes(totalGzipSize)}`,
            `Total brotli size: ${formatBytes(totalBrotliSize)}`,
            "",
            "Top 5 chunks by parsed size:",
            ...topChunks.map(
              (row, index) =>
                `  ${index + 1}. ${row.filename.padEnd(30)} ${formatBytes(row.parsedSize)}${row.isEntry ? " (entry)" : ""}`,
            ),
            "",
            "Top 5 packages by parsed size:",
            ...topPackages.map(
              (row, index) =>
                `  ${index + 1}. ${row.packageName.padEnd(16)} ${formatBytes(row.parsedSize)} (${row.moduleCount} modules)`,
            ),
            "",
            "Top 5 modules by parsed size:",
            ...topModules.map(
              (row, index) => `  ${index + 1}. ${row.path}  ${formatBytes(row.parsedSize)}`,
            ),
          ].join("\n"),
      ),
    );

    session.registerNamespace("bundle", {
      report: {
        summary: async () => session.getReport("bundle.summary")!.run(session),
      },
      chunks: async () => session.queryTable("bundle.dims.chunks"),
      modules: async () => session.queryTable("bundle.dims.modules"),
      packages: async () => session.queryTable("bundle.dims.packages"),
    });

    session.setId(hashFilePath(sourcePath));
    return session;
  }
}
