import { readFile } from "fs/promises";
import { gunzipSync } from "zlib";

export async function readMaybeGzipText(filePath: string): Promise<string> {
  if (filePath.endsWith(".gz")) {
    const compressed = await readFile(filePath);
    const decompressed = gunzipSync(compressed);
    return new TextDecoder().decode(decompressed);
  }

  return readFile(filePath, "utf8");
}
