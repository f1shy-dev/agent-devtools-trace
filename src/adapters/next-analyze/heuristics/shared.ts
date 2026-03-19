import type { AnalyzeData } from "../analyze-data";

export function getRouteAnalyze(data: Map<string, AnalyzeData>, route?: string): AnalyzeData {
  const routeKey = route || "/";
  const analyze = data.get(routeKey);
  if (!analyze) {
    throw new Error(`Route not found: ${routeKey}`);
  }
  return analyze;
}

export function getTotalChunkSizes(analyze: AnalyzeData): {
  totalSize: number;
  totalCompressedSize: number;
} {
  let totalSize = 0;
  let totalCompressedSize = 0;

  for (let i = 0; i < analyze.chunkPartCount(); i += 1) {
    const chunkPart = analyze.chunkPart(i);
    if (!chunkPart) {
      continue;
    }

    totalSize += chunkPart.size;
    totalCompressedSize += chunkPart.compressed_size;
  }

  return { totalSize, totalCompressedSize };
}

export function classifyEnvironment(filename: string): "client" | "server" | "traced" {
  if (filename.startsWith("[client-fs]/")) {
    return "client";
  }
  if (filename.startsWith("[project]/")) {
    return "traced";
  }
  return "server";
}

export function classifyOutputType(filename: string): "js" | "css" | "json" | "asset" {
  if (filename.endsWith(".js")) {
    return "js";
  }
  if (filename.endsWith(".css")) {
    return "css";
  }
  if (filename.endsWith(".json")) {
    return "json";
  }
  return "asset";
}
