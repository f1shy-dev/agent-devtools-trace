import type { NextAnalyzeData } from "..";

interface ModulesResponse {
  route: string;
  totalModules: number;
  modules: Array<{
    index: number;
    ident: string;
    path: string;
    dependencyCount: number;
    dependentCount: number;
    asyncDependencyCount: number;
    asyncDependentCount: number;
  }>;
}

export async function getModules(
  data: NextAnalyzeData,
  searchParams: URLSearchParams,
): Promise<ModulesResponse> {
  const route = searchParams.get("route") || "/";
  const requestedLimit = Number.parseInt(searchParams.get("limit") || "50", 10);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 50;

  const modules = Array.from({ length: data.modulesData.moduleCount() }, (_, index) => {
    const module = data.modulesData.module(index);
    return {
      index,
      ident: module?.ident ?? "",
      path: module?.path ?? "",
      dependencyCount: data.modulesData.moduleDependencies(index).length,
      dependentCount: data.modulesData.moduleDependents(index).length,
      asyncDependencyCount: data.modulesData.asyncModuleDependencies(index).length,
      asyncDependentCount: data.modulesData.asyncModuleDependents(index).length,
    };
  })
    .sort((left, right) => {
      const leftTotal =
        left.dependencyCount +
        left.dependentCount +
        left.asyncDependencyCount +
        left.asyncDependentCount;
      const rightTotal =
        right.dependencyCount +
        right.dependentCount +
        right.asyncDependencyCount +
        right.asyncDependentCount;
      return rightTotal - leftTotal || left.path.localeCompare(right.path);
    })
    .slice(0, limit);

  return {
    route,
    totalModules: data.modulesData.moduleCount(),
    modules,
  };
}
