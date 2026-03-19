export type ModuleIndex = number;
export type SourceIndex = number;

export interface AnalyzeModule {
  ident: string;
  path: string;
}

export interface AnalyzeSource {
  parent_source_index: number | null;
  path: string;
}

export interface AnalyzeChunkPart {
  source_index: number;
  output_file_index: number;
  size: number;
  compressed_size: number;
}

export interface AnalyzeOutputFile {
  filename: string;
}

export interface EdgesDataReference {
  offset: number;
  length: number;
}

interface AnalyzeDataHeader {
  sources: AnalyzeSource[];
  chunk_parts: AnalyzeChunkPart[];
  output_files: AnalyzeOutputFile[];
  output_file_chunk_parts: EdgesDataReference;
  source_chunk_parts: EdgesDataReference;
  source_children: EdgesDataReference;
  source_roots: number[];
}

interface ModulesDataHeader {
  modules: AnalyzeModule[];
  module_dependents: EdgesDataReference;
  async_module_dependents: EdgesDataReference;
  module_dependencies: EdgesDataReference;
  async_module_dependencies: EdgesDataReference;
}

export class ModulesData {
  private readonly modulesHeader: ModulesDataHeader;
  private readonly modulesBinaryData: DataView;
  private readonly pathToModuleIndices: Map<string, ModuleIndex[]>;

  constructor(modulesArrayBuffer: ArrayBuffer) {
    const modulesDataView = new DataView(modulesArrayBuffer);
    const modulesJsonLength = modulesDataView.getUint32(0, false);
    const modulesJsonBytes = new Uint8Array(modulesArrayBuffer, 4, modulesJsonLength);
    const modulesJsonString = new TextDecoder("utf-8").decode(modulesJsonBytes);
    this.modulesHeader = JSON.parse(modulesJsonString) as ModulesDataHeader;
    const modulesBinaryOffset = 4 + modulesJsonLength;
    this.modulesBinaryData = new DataView(modulesArrayBuffer, modulesBinaryOffset);

    this.pathToModuleIndices = new Map();
    for (let i = 0; i < this.modulesHeader.modules.length; i += 1) {
      const module = this.modulesHeader.modules[i];
      if (!module) {
        continue;
      }

      const existing = this.pathToModuleIndices.get(module.path);
      if (existing) {
        existing.push(i);
      } else {
        this.pathToModuleIndices.set(module.path, [i]);
      }
    }
  }

  module(index: ModuleIndex): AnalyzeModule | undefined {
    return this.modulesHeader.modules[index];
  }

  moduleCount(): number {
    return this.modulesHeader.modules.length;
  }

  getModuleIndicesFromPath(path: string): ModuleIndex[] {
    return this.pathToModuleIndices.get(path) ?? [];
  }

  moduleDependents(index: ModuleIndex): ModuleIndex[] {
    return this.readEdgesDataAtIndex(this.modulesHeader.module_dependents, index);
  }

  asyncModuleDependents(index: ModuleIndex): ModuleIndex[] {
    return this.readEdgesDataAtIndex(this.modulesHeader.async_module_dependents, index);
  }

  moduleDependencies(index: ModuleIndex): ModuleIndex[] {
    return this.readEdgesDataAtIndex(this.modulesHeader.module_dependencies, index);
  }

  asyncModuleDependencies(index: ModuleIndex): ModuleIndex[] {
    return this.readEdgesDataAtIndex(this.modulesHeader.async_module_dependencies, index);
  }

  private readEdgesDataAtIndex(reference: EdgesDataReference, index: ModuleIndex): ModuleIndex[] {
    const { offset, length } = reference;
    if (length === 0) {
      return [];
    }

    const numOffsets = this.modulesBinaryData.getUint32(offset, false);
    if (index < 0 || index >= numOffsets) {
      return [];
    }

    const offsetsStart = offset + 4;
    const prevOffset =
      index === 0 ? 0 : this.modulesBinaryData.getUint32(offsetsStart + (index - 1) * 4, false);
    const currentOffset = this.modulesBinaryData.getUint32(offsetsStart + index * 4, false);
    const edgeCount = currentOffset - prevOffset;
    if (edgeCount === 0) {
      return [];
    }

    const dataStart = offset + 4 + numOffsets * 4;
    const edges: number[] = [];
    for (let i = 0; i < edgeCount; i += 1) {
      edges.push(this.modulesBinaryData.getUint32(dataStart + (prevOffset + i) * 4, false));
    }

    return edges;
  }
}

export class AnalyzeData {
  private readonly analyzeHeader: AnalyzeDataHeader;
  private readonly analyzeBinaryData: DataView;
  private readonly pathToSourceIndex: Map<string, SourceIndex>;

  constructor(analyzeArrayBuffer: ArrayBuffer) {
    const analyzeDataView = new DataView(analyzeArrayBuffer);
    const analyzeJsonLength = analyzeDataView.getUint32(0, false);
    const analyzeJsonBytes = new Uint8Array(analyzeArrayBuffer, 4, analyzeJsonLength);
    const analyzeJsonString = new TextDecoder("utf-8").decode(analyzeJsonBytes);
    this.analyzeHeader = JSON.parse(analyzeJsonString) as AnalyzeDataHeader;
    const analyzeBinaryOffset = 4 + analyzeJsonLength;
    this.analyzeBinaryData = new DataView(analyzeArrayBuffer, analyzeBinaryOffset);

    this.pathToSourceIndex = new Map();
    for (let i = 0; i < this.analyzeHeader.sources.length; i += 1) {
      this.pathToSourceIndex.set(this.getFullSourcePath(i), i);
    }
  }

  source(index: SourceIndex): AnalyzeSource | undefined {
    return this.analyzeHeader.sources[index];
  }

  sourceCount(): number {
    return this.analyzeHeader.sources.length;
  }

  getSourceIndexFromPath(path: string): SourceIndex | undefined {
    return this.pathToSourceIndex.get(path);
  }

  chunkPart(index: number): AnalyzeChunkPart | undefined {
    return this.analyzeHeader.chunk_parts[index];
  }

  chunkPartCount(): number {
    return this.analyzeHeader.chunk_parts.length;
  }

  outputFile(index: number): AnalyzeOutputFile | undefined {
    return this.analyzeHeader.output_files[index];
  }

  outputFileCount(): number {
    return this.analyzeHeader.output_files.length;
  }

  sourceRoots(): SourceIndex[] {
    return this.analyzeHeader.source_roots;
  }

  outputFileChunkParts(index: number): number[] {
    return this.readEdgesDataAtIndex(this.analyzeHeader.output_file_chunk_parts, index);
  }

  sourceChunkParts(index: SourceIndex): number[] {
    return this.readEdgesDataAtIndex(this.analyzeHeader.source_chunk_parts, index);
  }

  sourceChildren(index: SourceIndex): SourceIndex[] {
    return this.readEdgesDataAtIndex(this.analyzeHeader.source_children, index);
  }

  getFullSourcePath(index: SourceIndex): string {
    const source = this.source(index);
    if (!source) {
      return "";
    }

    if (source.parent_source_index === null) {
      return source.path;
    }

    return this.getFullSourcePath(source.parent_source_index) + source.path;
  }

  getOwnSizes(index: SourceIndex): { size: number; compressedSize: number } {
    let size = 0;
    let compressedSize = 0;

    for (const chunkPartIndex of this.sourceChunkParts(index)) {
      const chunkPart = this.chunkPart(chunkPartIndex);
      if (!chunkPart) {
        continue;
      }

      size += chunkPart.size;
      compressedSize += chunkPart.compressed_size;
    }

    return { size, compressedSize };
  }

  getRecursiveSizes(
    index: SourceIndex,
    filterSource: (sourceIndex: SourceIndex) => boolean,
  ): { size: number; compressedSize: number } {
    let size = 0;
    let compressedSize = 0;

    if (filterSource(index)) {
      const ownSizes = this.getOwnSizes(index);
      size += ownSizes.size;
      compressedSize += ownSizes.compressedSize;
    }

    for (const childIndex of this.sourceChildren(index)) {
      const childSizes = this.getRecursiveSizes(childIndex, filterSource);
      size += childSizes.size;
      compressedSize += childSizes.compressedSize;
    }

    return { size, compressedSize };
  }

  getSourceFlags(index: SourceIndex): {
    client: boolean;
    server: boolean;
    traced: boolean;
    js: boolean;
    css: boolean;
    json: boolean;
    asset: boolean;
  } {
    let client = false;
    let server = false;
    let traced = false;
    let js = false;
    let css = false;
    let json = false;
    let asset = false;

    for (const chunkPartIndex of this.sourceChunkParts(index)) {
      const chunkPart = this.chunkPart(chunkPartIndex);
      if (!chunkPart) {
        continue;
      }

      const outputFile = this.outputFile(chunkPart.output_file_index);
      if (!outputFile) {
        continue;
      }

      if (outputFile.filename.startsWith("[client-fs]/")) {
        client = true;
      } else if (outputFile.filename.startsWith("[project]/")) {
        traced = true;
      } else {
        server = true;
      }

      if (outputFile.filename.endsWith(".js")) {
        js = true;
      } else if (outputFile.filename.endsWith(".css")) {
        css = true;
      } else if (outputFile.filename.endsWith(".json")) {
        json = true;
      } else {
        asset = true;
      }
    }

    return { client, server, traced, js, css, json, asset };
  }

  private readEdgesDataAtIndex(reference: EdgesDataReference, index: SourceIndex): SourceIndex[] {
    const { offset, length } = reference;
    if (length === 0) {
      return [];
    }

    const numOffsets = this.analyzeBinaryData.getUint32(offset, false);
    if (index < 0 || index >= numOffsets) {
      return [];
    }

    const offsetsStart = offset + 4;
    const prevOffset =
      index === 0 ? 0 : this.analyzeBinaryData.getUint32(offsetsStart + (index - 1) * 4, false);
    const currentOffset = this.analyzeBinaryData.getUint32(offsetsStart + index * 4, false);
    const edgeCount = currentOffset - prevOffset;
    if (edgeCount === 0) {
      return [];
    }

    const dataStart = offset + 4 + numOffsets * 4;
    const edges: number[] = [];
    for (let i = 0; i < edgeCount; i += 1) {
      edges.push(this.analyzeBinaryData.getUint32(dataStart + (prevOffset + i) * 4, false));
    }

    return edges;
  }
}
