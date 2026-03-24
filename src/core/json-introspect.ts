import type { JsonValue } from "../shared/types.js";

export interface JsonPathInfo {
  path: string;
  count: number;
  types: string[];
  samples: Array<string | number | boolean | null>;
}

function typeOfValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function discoverJsonPaths(value: unknown): JsonPathInfo[] {
  const map = new Map<string, { count: number; types: Set<string>; samples: Array<string | number | boolean | null> }>();

  const visit = (current: unknown, path: string) => {
    const type = typeOfValue(current);
    if (!map.has(path)) {
      map.set(path, { count: 0, types: new Set(), samples: [] });
    }
    const row = map.get(path)!;
    row.count += 1;
    row.types.add(type);
    if (
      (typeof current === "string" || typeof current === "number" || typeof current === "boolean" || current === null) &&
      row.samples.length < 5 &&
      !row.samples.includes(current)
    ) {
      row.samples.push(current);
    }

    if (Array.isArray(current)) {
      for (const item of current) {
        visit(item, path ? `${path}[]` : "[]");
      }
      return;
    }

    if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        const nextPath = path ? `${path}.${key}` : key;
        visit(child, nextPath);
      }
    }
  };

  visit(value, "$"
  );

  return [...map.entries()]
    .map(([path, info]) => ({
      path,
      count: info.count,
      types: [...info.types].sort(),
      samples: info.samples,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function parsePath(path: string) {
  if (path === "$" || path.length === 0) return [] as Array<{ key?: string; array: boolean }>;
  const normalized = path.startsWith("$.") ? path.slice(2) : path;
  if (normalized.length === 0) return [] as Array<{ key?: string; array: boolean }>;
  return normalized.split(".").map((segment) => {
    if (segment === "[]") return { array: true };
    if (segment.endsWith("[]")) {
      return { key: segment.slice(0, -2), array: true };
    }
    return { key: segment, array: false };
  });
}

export function sampleJsonPath(value: unknown, path: string, limit = 5): unknown[] {
  const tokens = parsePath(path);
  let current: unknown[] = [value];

  for (const token of tokens) {
    const next: unknown[] = [];
    for (const item of current) {
      const base = token.key ? (item as any)?.[token.key] : item;
      if (token.array) {
        if (Array.isArray(base)) next.push(...base);
      } else if (base !== undefined) {
        next.push(base);
      }
    }
    current = next;
  }

  return current.slice(0, limit);
}

export function detectTimeLikePaths(paths: JsonPathInfo[]) {
  const matcher = /(time|timestamp|duration|start|end|ts)/i;
  return paths
    .filter((row) => matcher.test(row.path) && row.types.some((type) => type === "number" || type === "string"))
    .map((row) => row.path);
}

export function isLikelyBase64(value: string) {
  if (value.length < 16 || value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

export interface EmbeddedBlobCandidate {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
}

export function findEmbeddedBlobs(value: unknown): EmbeddedBlobCandidate[] {
  const found: EmbeddedBlobCandidate[] = [];

  const walk = (current: unknown, path: string) => {
    if (typeof current === "string") {
      const dataUrl = current.match(/^data:([^;,]+);base64,(.+)$/);
      if (dataUrl) {
        found.push({
          path,
          mediaType: dataUrl[1]!,
          bytes: Buffer.from(dataUrl[2]!, "base64"),
        });
        return;
      }
      if (/(snapshot|base64|blob|image|payload)$/i.test(path) && isLikelyBase64(current)) {
        found.push({
          path,
          mediaType: "application/octet-stream",
          bytes: Buffer.from(current, "base64"),
        });
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current as Record<string, JsonValue>)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };

  walk(value, "$"
  );
  return found;
}
