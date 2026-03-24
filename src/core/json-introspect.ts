import { gunzipSync } from "zlib";
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

  visit(value, "$");

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

function isLikelyByteArray(value: unknown) {
  return Array.isArray(value) && value.length >= 8 && value.every((item) => Number.isInteger(item) && item >= 0 && item <= 255);
}

function looksLikeUtf8(bytes: Uint8Array) {
  try {
    const text = Buffer.from(bytes).toString("utf8");
    if (!text) return false;
    const controlChars = [...text].filter((char) => char < " " && !["\n", "\r", "\t"].includes(char)).length;
    return controlChars <= Math.max(1, Math.floor(text.length * 0.02));
  } catch {
    return false;
  }
}

function sniffMediaType(bytes: Uint8Array) {
  const b = bytes;
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image/gif";
  if (b.length >= 4 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "application/zip";
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return "application/gzip";
  if (looksLikeUtf8(bytes)) {
    const text = Buffer.from(bytes).toString("utf8").trim();
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try {
        JSON.parse(text);
        return "application/json";
      } catch {}
    }
    return "text/plain";
  }
  return "application/octet-stream";
}

function deriveDecodedKind(mediaType: string) {
  if (mediaType === "application/json") return "json" as const;
  if (mediaType.startsWith("text/")) return "text" as const;
  return "binary" as const;
}

function maybeGunzip(bytes: Uint8Array) {
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;
  try {
    return new Uint8Array(gunzipSync(Buffer.from(bytes)));
  } catch {
    return null;
  }
}

export interface EmbeddedBlobCandidate {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
  filenameHint?: string;
  confidence: "high" | "medium" | "low";
  encoding: string;
  decodedKind: "binary" | "text" | "json";
  containerKind: "data-url" | "base64-string" | "wrapper-object" | "byte-array";
}

function buildCandidate(args: {
  path: string;
  bytes: Uint8Array;
  hintedMediaType?: string;
  filenameHint?: string;
  confidence: "high" | "medium" | "low";
  encoding: string;
  containerKind: EmbeddedBlobCandidate["containerKind"];
}) {
  const gunzipped = maybeGunzip(args.bytes);
  const finalBytes = gunzipped ?? args.bytes;
  const sniffed = sniffMediaType(finalBytes);
  const mediaType = args.hintedMediaType && args.hintedMediaType !== "application/octet-stream" ? args.hintedMediaType : sniffed;
  return {
    path: args.path,
    mediaType,
    bytes: finalBytes,
    filenameHint: args.filenameHint,
    confidence: args.confidence,
    encoding: gunzipped ? `${args.encoding}+gzip` : args.encoding,
    decodedKind: deriveDecodedKind(mediaType),
    containerKind: args.containerKind,
  } satisfies EmbeddedBlobCandidate;
}

function wrapperHints(value: Record<string, unknown>) {
  const mediaType =
    typeof value.mimeType === "string"
      ? value.mimeType
      : typeof value.contentType === "string"
        ? value.contentType
        : typeof value.mediaType === "string"
          ? value.mediaType
          : undefined;
  const filenameHint =
    typeof value.filename === "string"
      ? value.filename
      : typeof value.name === "string" && value.name.includes(".")
        ? value.name
        : undefined;
  const encoding = typeof value.encoding === "string" ? value.encoding.toLowerCase() : undefined;
  return { mediaType, filenameHint, encoding };
}

function fromWrapperObject(path: string, value: Record<string, unknown>) {
  const { mediaType, filenameHint, encoding } = wrapperHints(value);
  const candidates = ["data", "body", "content", "payload", "bytesBase64", "base64", "snapshot"];
  for (const key of candidates) {
    const current = value[key];
    if (typeof current === "string") {
      const dataUrl = current.match(/^data:([^;,]+);base64,(.+)$/);
      if (dataUrl) {
        return buildCandidate({
          path: `${path}.${key}`,
          bytes: Buffer.from(dataUrl[2]!, "base64"),
          hintedMediaType: dataUrl[1]!,
          filenameHint,
          confidence: "high",
          encoding: "data-url+base64",
          containerKind: "wrapper-object",
        });
      }
      if (encoding === "base64" || key.toLowerCase().includes("base64") || isLikelyBase64(current)) {
        return buildCandidate({
          path: `${path}.${key}`,
          bytes: Buffer.from(current, "base64"),
          hintedMediaType: mediaType,
          filenameHint,
          confidence: encoding === "base64" ? "high" : "medium",
          encoding: "base64",
          containerKind: "wrapper-object",
        });
      }
      if ((mediaType?.startsWith("text/") || mediaType === "application/json") && current.length > 0) {
        return buildCandidate({
          path: `${path}.${key}`,
          bytes: Buffer.from(current, "utf8"),
          hintedMediaType: mediaType,
          filenameHint,
          confidence: "medium",
          encoding: "utf8",
          containerKind: "wrapper-object",
        });
      }
    }
    if (isLikelyByteArray(current)) {
      return buildCandidate({
        path: `${path}.${key}`,
        bytes: Uint8Array.from(current as number[]),
        hintedMediaType: mediaType,
        filenameHint,
        confidence: "high",
        encoding: "bytes",
        containerKind: "wrapper-object",
      });
    }
  }
  return null;
}

export function findEmbeddedBlobs(value: unknown): EmbeddedBlobCandidate[] {
  const found: EmbeddedBlobCandidate[] = [];
  const seen = new Set<string>();

  const push = (candidate: EmbeddedBlobCandidate | null) => {
    if (!candidate || seen.has(candidate.path)) return;
    seen.add(candidate.path);
    found.push(candidate);
  };

  const walk = (current: unknown, path: string) => {
    if (typeof current === "string") {
      const dataUrl = current.match(/^data:([^;,]+);base64,(.+)$/);
      if (dataUrl) {
        push(
          buildCandidate({
            path,
            bytes: Buffer.from(dataUrl[2]!, "base64"),
            hintedMediaType: dataUrl[1]!,
            confidence: "high",
            encoding: "data-url+base64",
            containerKind: "data-url",
          }),
        );
        return;
      }
      if (/(snapshot|base64|blob|image|payload|body|content)$/i.test(path) && isLikelyBase64(current)) {
        push(
          buildCandidate({
            path,
            bytes: Buffer.from(current, "base64"),
            confidence: "medium",
            encoding: "base64",
            containerKind: "base64-string",
          }),
        );
      }
      return;
    }
    if (isLikelyByteArray(current)) {
      push(
        buildCandidate({
          path,
          bytes: Uint8Array.from(current as number[]),
          confidence: "medium",
          encoding: "bytes",
          containerKind: "byte-array",
        }),
      );
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (current && typeof current === "object") {
      const objectCurrent = current as Record<string, JsonValue>;
      push(fromWrapperObject(path, objectCurrent as Record<string, unknown>));
      for (const [key, child] of Object.entries(objectCurrent)) {
        walk(child, path ? `${path}.${key}` : key);
      }
    }
  };

  walk(value, "$");
  return found;
}
