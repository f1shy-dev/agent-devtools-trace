import { mkdirSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";

interface EdgesDataReference {
  offset: number;
  length: number;
}

interface ModulesDataHeader {
  modules: Array<{ ident: string; path: string }>;
  module_dependents: EdgesDataReference;
  async_module_dependents: EdgesDataReference;
  module_dependencies: EdgesDataReference;
  async_module_dependencies: EdgesDataReference;
}

interface AnalyzeDataHeader {
  sources: Array<{ parent_source_index: number | null; path: string }>;
  chunk_parts: Array<{
    source_index: number;
    output_file_index: number;
    size: number;
    compressed_size: number;
  }>;
  output_files: Array<{ filename: string }>;
  output_file_chunk_parts: EdgesDataReference;
  source_chunk_parts: EdgesDataReference;
  source_children: EdgesDataReference;
  source_roots: number[];
}

export function writeEdgesData(edgesPerIndex: number[][]): { offsets: number[]; data: number[] } {
  let currentOffset = 0;
  const data: number[] = [];
  const offsets = edgesPerIndex.map((edges) => {
    currentOffset += edges.length;
    data.push(...edges);
    return currentOffset;
  });
  return { offsets, data };
}

export function buildDataFile(
  headerJson: object,
  edgeSections: Array<{ offsets: number[]; data: number[] }>,
): Buffer {
  const headerBytes = Buffer.from(JSON.stringify(headerJson), "utf-8");
  let binarySize = 0;
  for (const section of edgeSections) {
    binarySize += 4 + section.offsets.length * 4 + section.data.length * 4;
  }

  const buffer = Buffer.alloc(4 + headerBytes.length + binarySize);
  buffer.writeUInt32BE(headerBytes.length, 0);
  headerBytes.copy(buffer, 4);

  let position = 4 + headerBytes.length;
  for (const section of edgeSections) {
    buffer.writeUInt32BE(section.offsets.length, position);
    position += 4;
    for (const offset of section.offsets) {
      buffer.writeUInt32BE(offset, position);
      position += 4;
    }
    for (const value of section.data) {
      buffer.writeUInt32BE(value, position);
      position += 4;
    }
  }

  return buffer;
}

function buildModulesFixture(): Buffer {
  const modules = [
    { ident: "app/page.tsx", path: "/app/page.tsx" },
    { ident: "app/components/header.tsx", path: "/app/components/header.tsx" },
    { ident: "app/components/footer.tsx", path: "/app/components/footer.tsx" },
    { ident: "app/about/page.tsx", path: "/app/about/page.tsx" },
    { ident: "node_modules/react/index.js", path: "/node_modules/react/index.js" },
    { ident: "node_modules/react-dom/index.js", path: "/node_modules/react-dom/index.js" },
    { ident: "lib/api.ts", path: "/lib/api.ts" },
    { ident: "styles/global.css", path: "/styles/global.css" },
    { ident: "node_modules/chart.js/index.js", path: "/node_modules/chart.js/index.js" },
    { ident: "app/dashboard/page.tsx", path: "/app/dashboard/page.tsx" },
  ];

  const moduleDependents = writeEdgesData([
    [],
    [0],
    [0],
    [],
    [1, 2, 3, 9],
    [0, 3, 9],
    [0, 3, 9],
    [0, 3],
    [9],
    [],
  ]);
  const asyncModuleDependents = writeEdgesData([[], [], [], [], [], [], [], [], [0], []]);
  const moduleDependencies = writeEdgesData([
    [1, 2, 5, 6, 7],
    [4],
    [4],
    [1, 4, 5, 6, 7],
    [],
    [],
    [4],
    [],
    [],
    [1, 4, 5, 6],
  ]);
  const asyncModuleDependencies = writeEdgesData([[], [], [], [], [], [], [], [], [], [8]]);

  const header: ModulesDataHeader = {
    modules,
    module_dependents: { offset: 0, length: 0 },
    async_module_dependents: { offset: 0, length: 0 },
    module_dependencies: { offset: 0, length: 0 },
    async_module_dependencies: { offset: 0, length: 0 },
  };

  const sections = [
    moduleDependents,
    asyncModuleDependents,
    moduleDependencies,
    asyncModuleDependencies,
  ];
  let offset = 0;
  const refs = sections.map((section) => {
    const length = 4 + section.offsets.length * 4 + section.data.length * 4;
    const reference = { offset, length };
    offset += length;
    return reference;
  });

  header.module_dependents = refs[0]!;
  header.async_module_dependents = refs[1]!;
  header.module_dependencies = refs[2]!;
  header.async_module_dependencies = refs[3]!;

  return buildDataFile(header, sections);
}

function buildRootAnalyzeFixture(): Buffer {
  const sources = [
    { parent_source_index: null, path: "[project]/" },
    { parent_source_index: 0, path: "app/" },
    { parent_source_index: 1, path: "page.tsx" },
    { parent_source_index: 1, path: "components/" },
    { parent_source_index: 3, path: "header.tsx" },
    { parent_source_index: 3, path: "footer.tsx" },
    { parent_source_index: 0, path: "lib/" },
    { parent_source_index: 6, path: "api.ts" },
    { parent_source_index: 0, path: "styles/" },
    { parent_source_index: 8, path: "global.css" },
  ];
  const outputFiles = [
    { filename: "[client-fs]/app/page.js" },
    { filename: "[server]/app/page.js" },
    { filename: "[client-fs]/app/page.css" },
    { filename: "[server]/app/page.css" },
    { filename: "[project]/app/page.nft.json" },
  ];
  const chunkParts = [
    { source_index: 2, output_file_index: 0, size: 1200, compressed_size: 500 },
    { source_index: 4, output_file_index: 0, size: 400, compressed_size: 180 },
    { source_index: 5, output_file_index: 0, size: 350, compressed_size: 150 },
    { source_index: 7, output_file_index: 0, size: 600, compressed_size: 250 },
    { source_index: 9, output_file_index: 2, size: 220, compressed_size: 110 },
    { source_index: 2, output_file_index: 1, size: 900, compressed_size: 360 },
    { source_index: 4, output_file_index: 1, size: 280, compressed_size: 120 },
    { source_index: 5, output_file_index: 1, size: 250, compressed_size: 100 },
    { source_index: 7, output_file_index: 1, size: 520, compressed_size: 220 },
    { source_index: 2, output_file_index: 4, size: 64, compressed_size: 32 },
  ];

  const outputFileChunkParts = writeEdgesData([
    [0, 1, 2, 3],
    [5, 6, 7, 8],
    [4],
    [],
    [9],
  ]);
  const sourceChunkParts = writeEdgesData([
    [],
    [],
    [0, 5, 9],
    [],
    [1, 6],
    [2, 7],
    [],
    [3, 8],
    [],
    [4],
  ]);
  const sourceChildren = writeEdgesData([
    [1, 6, 8],
    [2, 3],
    [],
    [4, 5],
    [],
    [],
    [7],
    [],
    [9],
    [],
  ]);

  const header: AnalyzeDataHeader = {
    sources,
    chunk_parts: chunkParts,
    output_files: outputFiles,
    output_file_chunk_parts: { offset: 0, length: 0 },
    source_chunk_parts: { offset: 0, length: 0 },
    source_children: { offset: 0, length: 0 },
    source_roots: [0],
  };
  const sections = [outputFileChunkParts, sourceChunkParts, sourceChildren];
  let offset = 0;
  const refs = sections.map((section) => {
    const length = 4 + section.offsets.length * 4 + section.data.length * 4;
    const reference = { offset, length };
    offset += length;
    return reference;
  });

  header.output_file_chunk_parts = refs[0]!;
  header.source_chunk_parts = refs[1]!;
  header.source_children = refs[2]!;

  return buildDataFile(header, sections);
}

function buildAboutAnalyzeFixture(): Buffer {
  const sources = [
    { parent_source_index: null, path: "[project]/" },
    { parent_source_index: 0, path: "app/about/" },
    { parent_source_index: 1, path: "page.tsx" },
    { parent_source_index: 0, path: "styles/" },
    { parent_source_index: 3, path: "about.css" },
  ];
  const outputFiles = [
    { filename: "[client-fs]/app/about/page.js" },
    { filename: "[server]/app/about/page.js" },
    { filename: "[client-fs]/app/about/page.css" },
  ];
  const chunkParts = [
    { source_index: 2, output_file_index: 0, size: 700, compressed_size: 280 },
    { source_index: 2, output_file_index: 1, size: 520, compressed_size: 210 },
    { source_index: 4, output_file_index: 2, size: 120, compressed_size: 60 },
  ];

  const outputFileChunkParts = writeEdgesData([[0], [1], [2]]);
  const sourceChunkParts = writeEdgesData([[], [], [0, 1], [], [2]]);
  const sourceChildren = writeEdgesData([[1, 3], [2], [], [4], []]);

  const header: AnalyzeDataHeader = {
    sources,
    chunk_parts: chunkParts,
    output_files: outputFiles,
    output_file_chunk_parts: { offset: 0, length: 0 },
    source_chunk_parts: { offset: 0, length: 0 },
    source_children: { offset: 0, length: 0 },
    source_roots: [0],
  };
  const sections = [outputFileChunkParts, sourceChunkParts, sourceChildren];
  let offset = 0;
  const refs = sections.map((section) => {
    const length = 4 + section.offsets.length * 4 + section.data.length * 4;
    const reference = { offset, length };
    offset += length;
    return reference;
  });

  header.output_file_chunk_parts = refs[0]!;
  header.source_chunk_parts = refs[1]!;
  header.source_children = refs[2]!;

  return buildDataFile(header, sections);
}

export function writeFixture(rootDir: string): void {
  const resolvedRoot = resolve(rootDir);
  mkdirSync(resolvedRoot, { recursive: true });
  mkdirSync(join(resolvedRoot, "about"), { recursive: true });

  writeFileSync(join(resolvedRoot, "modules.data"), buildModulesFixture());
  writeFileSync(join(resolvedRoot, "routes.json"), JSON.stringify(["/", "/about"], null, 2));
  writeFileSync(join(resolvedRoot, "analyze.data"), buildRootAnalyzeFixture());
  writeFileSync(join(resolvedRoot, "about", "analyze.data"), buildAboutAnalyzeFixture());
}

if (import.meta.main) {
  const targetDir = process.argv[2]
    ? resolve(process.argv[2])
    : resolve(dirname(new URL(import.meta.url).pathname), "next-analyze");
  writeFixture(targetDir);
}
