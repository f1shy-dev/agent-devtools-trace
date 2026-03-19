import type { NextAnalyzeData } from "..";
import { getTotalChunkSizes } from "./shared";

interface RoutesResponse {
  routes: Array<{
    route: string;
    sourceCount: number;
    outputFileCount: number;
    chunkPartCount: number;
    totalSize: number;
    totalCompressedSize: number;
  }>;
}

export async function getRoutes(data: NextAnalyzeData): Promise<RoutesResponse> {
  const routes = [...data.routeAnalyzeData.entries()]
    .map(([route, analyze]) => {
      const totals = getTotalChunkSizes(analyze);
      return {
        route,
        sourceCount: analyze.sourceCount(),
        outputFileCount: analyze.outputFileCount(),
        chunkPartCount: analyze.chunkPartCount(),
        totalSize: totals.totalSize,
        totalCompressedSize: totals.totalCompressedSize,
      };
    })
    .sort((left, right) => left.route.localeCompare(right.route));

  return { routes };
}
