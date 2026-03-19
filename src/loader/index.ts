import { resolve } from "path";
import type { TraceAdapter } from "../shared/adapter";
import { DevToolsAdapter } from "../adapters/devtools";

const adapters: TraceAdapter[] = [new DevToolsAdapter()];

export interface LoadResult {
  adapter: TraceAdapter;
  data: unknown;
}

export async function loadTrace(filePath: string): Promise<LoadResult> {
  const resolved = resolve(filePath);
  for (const adapter of adapters) {
    if (adapter.canLoad(resolved)) {
      const data = await adapter.load(resolved);
      return { adapter, data };
    }
  }

  throw new Error(`No loader found for: ${filePath}`);
}
