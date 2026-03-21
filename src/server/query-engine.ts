import vm from "node:vm";
import { DEFAULT_QUERY_TIMEOUT, MAX_RESULT_SIZE } from "../shared/constants";
import type { Session } from "../shared/types";

export class QueryTimeoutError extends Error {
  readonly timeout: number;

  constructor(timeout: number) {
    super(`Query timed out after ${timeout}ms`);
    this.name = "QueryTimeoutError";
    this.timeout = timeout;
  }
}

async function transpile(source: string): Promise<string> {
  const bunRuntime = globalThis.Bun;
  if (bunRuntime) {
    return new bunRuntime.Transpiler({ loader: "ts" }).transformSync(source);
  }

  const ts = await import("typescript").then(m => m.default ?? m);
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ESNext,
    },
  }).outputText;
}

export function serializeResult(result: any): { serialized: string; truncated: boolean } {
  let str: string;
  try {
    str = JSON.stringify(result, null, 2);
  } catch {
    str = String(result);
  }

  if (typeof str !== "string") {
    str = "null";
  }

  if (str.length > MAX_RESULT_SIZE) {
    return {
      serialized: str.slice(0, MAX_RESULT_SIZE),
      truncated: true,
    };
  }

  return { serialized: str, truncated: false };
}

function findLastExpressionStart(code: string): number | null {
  let lastBoundary = 0;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inTemplate = false;
  let inLineComment = false;
  let inBlockComment = false;
  let escaped = false;

  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    const next = code[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
          lastBoundary = index + 1;
        }
      }
      continue;
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        index++;
      }
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inTemplate) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (inSingleQuote && char === "'") {
        inSingleQuote = false;
      } else if (inDoubleQuote && char === "\"") {
        inDoubleQuote = false;
      } else if (inTemplate && char === "`") {
        inTemplate = false;
      }
      continue;
    }

    if (char === "/" && next === "/") {
      inLineComment = true;
      index++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      index++;
      continue;
    }
    if (char === "'") {
      inSingleQuote = true;
      continue;
    }
    if (char === "\"") {
      inDoubleQuote = true;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "(") {
      parenDepth++;
      continue;
    }
    if (char === ")") {
      parenDepth = Math.max(parenDepth - 1, 0);
      continue;
    }
    if (char === "[") {
      bracketDepth++;
      continue;
    }
    if (char === "]") {
      bracketDepth = Math.max(bracketDepth - 1, 0);
      continue;
    }
    if (char === "{") {
      braceDepth++;
      continue;
    }
    if (char === "}") {
      braceDepth = Math.max(braceDepth - 1, 0);
      continue;
    }

    if (
      (char === ";" || char === "\n") &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      lastBoundary = index + 1;
    }
  }

  const trailingCode = code.slice(lastBoundary).trim();
  if (!trailingCode) {
    return null;
  }

  if (
    /^(return|throw|if|for|while|do|switch|try|class|function|async function|interface|type|enum|import|export)\b/.test(
      trailingCode,
    ) ||
    trailingCode === "}" ||
    trailingCode.endsWith("}")
  ) {
    return null;
  }

  return lastBoundary;
}

function withAutoReturn(code: string): string | null {
  const trimmedCode = code.trimEnd();
  const start = findLastExpressionStart(trimmedCode);
  if (start === null) {
    return null;
  }

  const prefix = trimmedCode.slice(0, start);
  const tail = trimmedCode.slice(start);
  const match = tail.match(/^(\s*)/);
  const indentation = match?.[1] ?? "";
  const expression = tail.slice(indentation.length);
  return `${prefix}${indentation}return ${expression}`;
}

async function buildQueryScript(
  code: string,
  mode: "expression" | "auto-return" | "statements",
): Promise<vm.Script> {
  const statementCode = mode === "auto-return" ? withAutoReturn(code) : code;
  if (mode === "auto-return" && statementCode === null) {
    throw new Error("Unable to infer trailing expression");
  }
  const wrappedCode =
    mode === "expression"
      ? `
        (async () => {
          return (${code});
        })()
      `
      : `
        (async () => {
          ${statementCode}
        })()
      `;
  const jsCode = await transpile(wrappedCode);

  return new vm.Script(jsCode);
}

export async function executeQuery(
  session: Session,
  code: string,
  timeout = DEFAULT_QUERY_TIMEOUT,
  queryOptions?: Record<string, string>,
): Promise<any> {
  const adapterContext = session.adapter.buildQueryContext(session.data, queryOptions);

  let script: vm.Script;
  try {
    script = await buildQueryScript(code, "expression");
  } catch {
    try {
      script = await buildQueryScript(code, "auto-return");
    } catch {
      script = await buildQueryScript(code, "statements");
    }
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new QueryTimeoutError(timeout));
    }, timeout);
    timeoutId.unref?.();
  });

  try {
    const context = {
      ...adapterContext,
      Buffer,
      console,
      performance,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      URL,
      TextDecoder,
      TextEncoder,
    };
    let result: unknown;
    try {
      result = script.runInNewContext(context, { timeout });
    } catch (error) {
      if (
        error instanceof Error &&
        /Script execution timed out|timed out after/i.test(error.message)
      ) {
        throw new QueryTimeoutError(timeout);
      }
      throw error;
    }

    return await Promise.race([
      Promise.resolve(result),
      timer,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
