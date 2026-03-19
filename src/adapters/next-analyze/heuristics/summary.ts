import type { NextAnalyzeData } from "..";
import type { Session } from "../../../shared/types";
import { getTotalChunkSizes } from "./shared";

interface AnalyzeSummary {
  file: string;
  type: "next-analyze";
  totalModules: number;
  totalRoutes: number;
  routes: string[];
  totalSources: number;
  totalOutputFiles: number;
  totalChunkParts: number;
  totalSize: number;
  totalCompressedSize: number;
  topSourcesBySize: Array<{ path: string; size: number; compressedSize: number }>;
  memorySizeMB: number;
}

export async function getSummary(
  data: NextAnalyzeData,
  session: Session,
): Promise<AnalyzeSummary> {
  const analyze = data.routeAnalyzeData.get("/") ?? data.routeAnalyzeData.values().next().value;
  const topSourcesBySize = analyze
    ? Array.from({ length: analyze.sourceCount() }, (_, index) => index)
        .map((index) => {
          const sizes = analyze.getOwnSizes(index);
          return {
            path: analyze.getFullSourcePath(index),
            size: sizes.size,
            compressedSize: sizes.compressedSize,
          };
        })
        .filter((entry) => entry.size > 0 || entry.compressedSize > 0)
        .sort((left, right) => right.size - left.size || right.compressedSize - left.compressedSize)
        .slice(0, 15)
    : [];
  const totals = analyze
    ? getTotalChunkSizes(analyze)
    : {
        totalSize: 0,
        totalCompressedSize: 0,
      };

  return {
    file: session.file,
    type: "next-analyze",
    totalModules: data.modulesData.moduleCount(),
    totalRoutes: data.routes.length,
    routes: data.routes,
    totalSources: analyze?.sourceCount() ?? 0,
    totalOutputFiles: analyze?.outputFileCount() ?? 0,
    totalChunkParts: analyze?.chunkPartCount() ?? 0,
    totalSize: totals.totalSize,
    totalCompressedSize: totals.totalCompressedSize,
    topSourcesBySize,
    memorySizeMB: session.memorySizeMB,
  };
}
