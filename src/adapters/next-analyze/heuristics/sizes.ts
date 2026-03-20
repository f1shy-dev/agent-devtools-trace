import type { NextAnalyzeData } from "..";
import { classifyEnvironment, classifyOutputType, getRouteAnalyze } from "./shared";

interface SizesResponse {
  route: string;
  byOutputType: Array<{ type: string; count: number; size: number; compressedSize: number }>;
  byEnvironment: Array<{ env: string; count: number; size: number; compressedSize: number }>;
  topOutputFiles: Array<{
    filename: string;
    size: number;
    compressedSize: number;
    chunkParts: number;
  }>;
}

export async function getSizes(
  data: NextAnalyzeData,
  searchParams: URLSearchParams,
): Promise<SizesResponse> {
  const route = searchParams.get("route") || "/";
  const analyze = getRouteAnalyze(data.routeAnalyzeData, route);
  const byOutputType = new Map<string, { type: string; count: number; size: number; compressedSize: number }>();
  const byEnvironment = new Map<string, { env: string; count: number; size: number; compressedSize: number }>();
  const outputFiles = new Map<
    string,
    { filename: string; size: number; compressedSize: number; chunkParts: number }
  >();

  for (let i = 0; i < analyze.chunkPartCount(); i += 1) {
    const chunkPart = analyze.chunkPart(i);
    if (!chunkPart) {
      continue;
    }

    const outputFile = analyze.outputFile(chunkPart.output_file_index);
    if (!outputFile) {
      continue;
    }

    const typeKey = classifyOutputType(outputFile.filename);
    const envKey = classifyEnvironment(outputFile.filename);

    const byTypeEntry = byOutputType.get(typeKey) ?? {
      type: typeKey,
      count: 0,
      size: 0,
      compressedSize: 0,
    };
    byTypeEntry.count += 1;
    byTypeEntry.size += chunkPart.size;
    byTypeEntry.compressedSize += chunkPart.compressed_size;
    byOutputType.set(typeKey, byTypeEntry);

    if (envKey !== "traced") {
      const byEnvEntry = byEnvironment.get(envKey) ?? {
        env: envKey,
        count: 0,
        size: 0,
        compressedSize: 0,
      };
      byEnvEntry.count += 1;
      byEnvEntry.size += chunkPart.size;
      byEnvEntry.compressedSize += chunkPart.compressed_size;
      byEnvironment.set(envKey, byEnvEntry);
    }

    const outputFileEntry = outputFiles.get(outputFile.filename) ?? {
      filename: outputFile.filename,
      size: 0,
      compressedSize: 0,
      chunkParts: 0,
    };
    outputFileEntry.size += chunkPart.size;
    outputFileEntry.compressedSize += chunkPart.compressed_size;
    outputFileEntry.chunkParts += 1;
    outputFiles.set(outputFile.filename, outputFileEntry);
  }

  return {
    route,
    byOutputType: [...byOutputType.values()].sort((left, right) => right.size - left.size),
    byEnvironment: [...byEnvironment.values()].sort((left, right) => right.size - left.size),
    topOutputFiles: [...outputFiles.values()]
      .sort((left, right) => right.size - left.size || left.filename.localeCompare(right.filename))
      .slice(0, 20),
  };
}
