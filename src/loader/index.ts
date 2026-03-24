import { statSync } from "fs";
import { resolve } from "path";
import { DevtoolsDriver } from "../drivers/devtools.js";
import { RawJsonDriver } from "../drivers/raw-json.js";
import type { DatasetSession, SourceDriver, SourceProbe } from "../core/types.js";

const drivers: SourceDriver[] = [new DevtoolsDriver(), new RawJsonDriver()];

function buildProbe(path: string): SourceProbe {
  const stat = statSync(path);
  return {
    path,
    isDirectory: stat.isDirectory(),
    sizeBytes: stat.size,
  };
}

export async function loadSource(filePath: string): Promise<DatasetSession> {
  const resolved = resolve(filePath);
  const probe = buildProbe(resolved);
  for (const driver of drivers) {
    const detection = await driver.detect(probe);
    if (!detection) continue;
    return driver.open(resolved, detection);
  }
  throw new Error(`No source driver found for: ${filePath}`);
}
