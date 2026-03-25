import { statSync } from "fs";
import { resolve } from "path";
import { DevtoolsDriver } from "../drivers/devtools.js";
import { ViteBundleDriver } from "../drivers/vite-bundle.js";
import { NextjsBundleDriver } from "../drivers/nextjs-bundle.js";
import { RawJsonDriver } from "../drivers/raw-json.js";
import type { DatasetSession, SourceDriver, SourceProbe } from "../core/types.js";

const drivers: SourceDriver[] = [
  new DevtoolsDriver(),
  new ViteBundleDriver(),
  new NextjsBundleDriver(),
  new RawJsonDriver(),
];

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
  const errors: Array<{ driver: string; error: string }> = [];
  for (const driver of drivers) {
    try {
      const detection = await driver.detect(probe);
      if (!detection) continue;
      return await driver.open(resolved, detection);
    } catch (error) {
      errors.push({
        driver: driver.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (errors.length > 0) {
    throw new Error(
      `Failed to load ${filePath}:\n${errors.map((entry) => `  ${entry.driver}: ${entry.error}`).join("\n")}`,
    );
  }
  throw new Error(`No source driver found for: ${filePath}`);
}
