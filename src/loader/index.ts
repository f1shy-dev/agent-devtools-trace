import { resolve } from "path";
import type { ParsedTrace } from "../shared/types";
import { DevToolsLoader } from "./devtools";
import type { TraceLoader } from "./types";

const loaders: TraceLoader[] = [new DevToolsLoader()];

export async function loadTrace(filePath: string): Promise<ParsedTrace> {
  const resolved = resolve(filePath);
  for (const loader of loaders) {
    if (loader.canLoad(resolved)) {
      return loader.load(resolved);
    }
  }

  throw new Error(`No loader found for: ${filePath}`);
}
