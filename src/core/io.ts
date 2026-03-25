import { createReadStream } from "fs";
import { readFile } from "fs/promises";
import { Writable } from "stream";
import { pipeline } from "stream/promises";
import { createGunzip, gunzipSync } from "zlib";

const DEFAULT_PEEK_BYTES = 64 * 1024;

class PeekCompleteError extends Error {
  constructor() {
    super("peek complete");
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseJsonRecord(text: string, description: string) {
  const parsed = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error(`Invalid DevTools trace: expected ${description} to be an object`);
  }
  return parsed as Record<string, any>;
}

function parseLeadingObjectFragment(text: string, arrayKey: string) {
  const trimmed = text.trimEnd();
  const escapedKey = escapeRegex(arrayKey);
  if (new RegExp(`^\\s*\\{\\s*"${escapedKey}"\\s*:\\s*$`).test(trimmed)) {
    return {};
  }
  const normalized = trimmed.replace(new RegExp(`,\\s*"${escapedKey}"\\s*:\\s*$`), "}");
  if (normalized === trimmed) {
    throw new Error(`Invalid DevTools trace: could not parse metadata before ${arrayKey}`);
  }
  return parseJsonRecord(normalized, "trace metadata prefix");
}

function parseTrailingObjectFragment(text: string) {
  const trimmed = text.trim();
  if (trimmed === "}") return {};
  if (trimmed.length === 0) {
    throw new Error("Invalid DevTools trace: unexpected end of file after traceEvents array");
  }
  if (!trimmed.startsWith(",")) {
    throw new Error("Invalid DevTools trace: unexpected content after traceEvents array");
  }
  return parseJsonRecord(`{${trimmed.slice(1)}`, "trace metadata suffix");
}

async function pipelineMaybeGunzip(filePath: string, sink: Writable) {
  const source = createReadStream(filePath);
  if (filePath.endsWith(".gz")) {
    await pipeline(source, createGunzip(), sink);
    return;
  }
  await pipeline(source, sink);
}

export async function readMaybeGzipText(filePath: string): Promise<string> {
  if (filePath.endsWith(".gz")) {
    const compressed = await readFile(filePath);
    const decompressed = gunzipSync(compressed);
    return new TextDecoder().decode(decompressed);
  }

  return readFile(filePath, "utf8");
}

export async function peekFileText(
  filePath: string,
  maxBytes = DEFAULT_PEEK_BYTES,
): Promise<string> {
  if (maxBytes <= 0) return "";

  const decoder = new TextDecoder();
  let remaining = maxBytes;
  let text = "";
  const sink = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const slice = remaining < buffer.length ? buffer.subarray(0, remaining) : buffer;
        if (slice.length > 0) {
          text += decoder.decode(slice, { stream: true });
          remaining -= slice.length;
        }
        callback(remaining <= 0 ? new PeekCompleteError() : undefined);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  try {
    await pipelineMaybeGunzip(filePath, sink);
  } catch (error) {
    if (!(error instanceof PeekCompleteError)) throw error;
  }

  return text + decoder.decode();
}

export async function streamParseJsonArray(
  filePath: string,
  options: { onItem: (item: any, index: number) => void; prefix?: string },
): Promise<{ prefix: Record<string, any> }> {
  const arrayKey = options.prefix ?? "traceEvents";
  const decoder = new TextDecoder();
  let mode: "before-array" | "in-array" | "after-array" | "done" = "before-array";
  let rootKind: "unknown" | "object" | "array" = "unknown";
  let beforeArrayText = "";
  let afterArrayText = "";
  let beforeDepth = 0;
  let beforeInString = false;
  let beforeEscape = false;
  let topLevelExpectingKey = false;
  let capturingKey = false;
  let currentKey = "";
  let lastCompletedKey: string | null = null;
  let awaitingArrayValue = false;
  let itemBuffer = "";
  let itemDepth = 0;
  let arrayInString = false;
  let arrayEscape = false;
  let itemIndex = 0;

  const consumeText = (text: string) => {
    for (const char of text) {
      if (mode === "done") {
        if (rootKind === "array" && /\S/.test(char)) {
          throw new Error("Invalid DevTools trace: unexpected content after root array");
        }
        continue;
      }

      if (mode === "after-array") {
        afterArrayText += char;
        continue;
      }

      if (mode === "before-array") {
        if (rootKind === "unknown") {
          if (/\s/.test(char)) {
            beforeArrayText += char;
            continue;
          }
          if (char === "[") {
            rootKind = "array";
            mode = "in-array";
            continue;
          }
          if (char === "{") {
            rootKind = "object";
            beforeArrayText += char;
            beforeDepth = 1;
            topLevelExpectingKey = true;
            continue;
          }
          throw new Error("Invalid DevTools trace: expected object or array");
        }

        if (beforeInString) {
          beforeArrayText += char;
          if (beforeEscape) {
            beforeEscape = false;
            if (capturingKey) currentKey += char;
            continue;
          }
          if (char === "\\") {
            beforeEscape = true;
            if (capturingKey) currentKey += char;
            continue;
          }
          if (char === '"') {
            beforeInString = false;
            if (capturingKey) {
              capturingKey = false;
              lastCompletedKey = currentKey;
              currentKey = "";
            }
            continue;
          }
          if (capturingKey) currentKey += char;
          continue;
        }

        if (awaitingArrayValue) {
          if (/\s/.test(char)) {
            beforeArrayText += char;
            continue;
          }
          if (char === "[") {
            mode = "in-array";
            continue;
          }
          beforeArrayText += char;
          awaitingArrayValue = false;
          continue;
        }

        if (char === '"') {
          beforeInString = true;
          beforeArrayText += char;
          if (beforeDepth === 1 && topLevelExpectingKey) {
            capturingKey = true;
            currentKey = "";
            lastCompletedKey = null;
          }
          continue;
        }

        beforeArrayText += char;
        if (char === "{") {
          beforeDepth += 1;
          if (beforeDepth === 1) topLevelExpectingKey = true;
          continue;
        }
        if (char === "[") {
          beforeDepth += 1;
          continue;
        }
        if (char === "}" || char === "]") {
          beforeDepth -= 1;
          continue;
        }
        if (beforeDepth === 1 && char === ":" && lastCompletedKey !== null) {
          topLevelExpectingKey = false;
          if (lastCompletedKey === arrayKey) awaitingArrayValue = true;
          lastCompletedKey = null;
          continue;
        }
        if (beforeDepth === 1 && char === ",") {
          topLevelExpectingKey = true;
          lastCompletedKey = null;
        }
        continue;
      }

      if (arrayInString) {
        itemBuffer += char;
        if (arrayEscape) {
          arrayEscape = false;
          continue;
        }
        if (char === "\\") {
          arrayEscape = true;
          continue;
        }
        if (char === '"') {
          arrayInString = false;
        }
        continue;
      }

      if (itemDepth > 0) {
        itemBuffer += char;
        if (char === '"') {
          arrayInString = true;
          continue;
        }
        if (char === "{") {
          itemDepth += 1;
          continue;
        }
        if (char === "}") {
          itemDepth -= 1;
          if (itemDepth === 0) {
            let item: any;
            try {
              item = JSON.parse(itemBuffer);
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              throw new Error(`Failed to parse DevTools trace event ${itemIndex}: ${message}`);
            }
            options.onItem(item, itemIndex);
            itemIndex += 1;
            itemBuffer = "";
          }
        }
        continue;
      }

      if (/\s/.test(char) || char === ",") continue;
      if (char === "{") {
        itemBuffer = "{";
        itemDepth = 1;
        continue;
      }
      if (char === "]") {
        mode = rootKind === "object" ? "after-array" : "done";
        continue;
      }
      throw new Error("Invalid DevTools trace: traceEvents array must contain objects");
    }
  };

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      try {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        consumeText(decoder.decode(buffer, { stream: true }));
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });

  await pipelineMaybeGunzip(filePath, sink);
  consumeText(decoder.decode());

  if (mode === "before-array") {
    throw new Error(`Invalid DevTools trace: missing ${arrayKey} array`);
  }
  if (mode === "in-array" || itemDepth !== 0 || arrayInString) {
    throw new Error("Invalid DevTools trace: unterminated traceEvents array");
  }
  if (rootKind === "array") {
    return { prefix: {} };
  }

  return {
    prefix: {
      ...parseLeadingObjectFragment(beforeArrayText, arrayKey),
      ...parseTrailingObjectFragment(afterArrayText),
    },
  };
}
