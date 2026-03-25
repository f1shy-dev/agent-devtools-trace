import vm from "node:vm";
import { transform } from "esbuild";
import ts from "typescript";
import { DEFAULT_QUERY_TIMEOUT, MAX_RESULT_SIZE } from "../shared/constants.js";
import { pretty as prettyValue, table as tableValue } from "../core/presentation.js";
import type { DatasetSession } from "../core/types.js";

export class QueryTimeoutError extends Error {
  readonly timeout: number;
  constructor(timeout: number) {
    const display = timeout >= 1000 ? `${(timeout / 1000).toFixed(1)}s` : `${timeout}ms`;
    super(`Query timed out after ${display}`);
    this.name = "QueryTimeoutError";
    this.timeout = timeout;
  }
}

const safeConsole = {
  log: (..._args: unknown[]) => {},
  warn: (..._args: unknown[]) => {},
  error: (..._args: unknown[]) => {},
  info: (..._args: unknown[]) => {},
  debug: (..._args: unknown[]) => {},
};
const drainMicrotasksScript = new vm.Script("");

function normalizeExecutionError(error: unknown, timeout: number) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" &&
          error !== null &&
          "message" in error &&
          typeof error.message === "string"
        ? error.message
        : typeof error === "string"
          ? error
          : null;
  if (message && /Script execution timed out|timed out after/i.test(message)) {
    return new QueryTimeoutError(timeout);
  }
  return error;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

function isQueryEnvelope(
  value: unknown,
): value is
  | { __traceServerQueryStatus: "fulfilled"; value: unknown }
  | { __traceServerQueryStatus: "rejected"; error: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    "__traceServerQueryStatus" in value &&
    (((value as any).__traceServerQueryStatus === "fulfilled" && "value" in (value as any)) ||
      ((value as any).__traceServerQueryStatus === "rejected" && "error" in (value as any)))
  );
}

async function transpile(source: string): Promise<string> {
  try {
    const result = await transform(source, {
      loader: "ts",
      format: "esm",
      target: "es2022",
      sourcemap: false,
    });
    return result.code;
  } catch (error) {
    const parsed = ts.createSourceFile("query.ts", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
    if (
      (parsed as any).parseDiagnostics?.some(
        (diagnostic: ts.Diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      )
    ) {
      throw error;
    }
    const result = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    });
    if (
      result.diagnostics?.some((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    ) {
      throw error;
    }
    return result.outputText;
  }
}

export function serializeResult(result: any): { serialized: string; truncated: boolean } {
  let str: string;
  if (typeof result === "string") {
    str = result;
  } else {
    try {
      str = JSON.stringify(result, null, 2);
    } catch {
      str = String(result);
    }
  }
  if (typeof str !== "string") str = "null";
  if (str.length > MAX_RESULT_SIZE) {
    return { serialized: str.slice(0, MAX_RESULT_SIZE), truncated: true };
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
    const char = code[index]!;
    const next = code[index + 1];

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) lastBoundary = index + 1;
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
      if (inSingleQuote && char === "'") inSingleQuote = false;
      else if (inDoubleQuote && char === '"') inDoubleQuote = false;
      else if (inTemplate && char === "`") inTemplate = false;
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
    if (char === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (char === "`") {
      inTemplate = true;
      continue;
    }

    if (char === "(") parenDepth++;
    else if (char === ")") parenDepth = Math.max(parenDepth - 1, 0);
    else if (char === "[") bracketDepth++;
    else if (char === "]") bracketDepth = Math.max(bracketDepth - 1, 0);
    else if (char === "{") braceDepth++;
    else if (char === "}") braceDepth = Math.max(braceDepth - 1, 0);
    else if (
      (char === ";" || char === "\n") &&
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0
    ) {
      lastBoundary = index + 1;
    }
  }

  const trailing = code.slice(lastBoundary).trim();
  if (!trailing) return null;
  if (
    /^(return|throw|if|for|while|do|switch|try|class|function|async function|interface|type|enum|import|export)\b/.test(
      trailing,
    )
  ) {
    return null;
  }
  if (trailing === "}" || trailing.endsWith("}")) return null;
  return lastBoundary;
}

function withAutoReturn(code: string): string | null {
  const trimmed = code.trimEnd();
  const start = findLastExpressionStart(trimmed);
  if (start === null) return null;
  const prefix = trimmed.slice(0, start);
  const tail = trimmed.slice(start);
  const indentation = tail.match(/^(\s*)/)?.[1] ?? "";
  const expression = tail.slice(indentation.length);
  return `${prefix}${indentation}return ${expression}`;
}

async function buildQueryScript(code: string, mode: "expression" | "auto-return" | "statements") {
  const statementCode = mode === "auto-return" ? withAutoReturn(code) : code;
  if (mode === "auto-return" && statementCode === null)
    throw new Error("Unable to infer trailing expression");
  const body =
    mode === "expression"
      ? `return (${code});`
      : mode === "auto-return"
        ? statementCode
        : `${statementCode}\nreturn undefined;`;
  const wrappedCode = `
    (async () => {
      try {
        return {
          __traceServerQueryStatus: "fulfilled",
          value: await (async () => {
            ${body}
          })(),
        };
      } catch (error) {
        return {
          __traceServerQueryStatus: "rejected",
          error,
        };
      }
    })()
  `;
  return new vm.Script(await transpile(wrappedCode));
}

async function compileQueryScript(code: string): Promise<vm.Script> {
  let expressionError: unknown;

  try {
    return await buildQueryScript(code, "expression");
  } catch (error) {
    expressionError = error;
  }

  try {
    return await buildQueryScript(code, "auto-return");
  } catch {}

  try {
    return await buildQueryScript(code, "statements");
  } catch {
    throw expressionError;
  }
}

export async function executeQuery(
  session: DatasetSession,
  code: string,
  timeout = DEFAULT_QUERY_TIMEOUT,
) {
  const script = await compileQueryScript(code);

  const abort = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const activeTimers = new Set<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();
  const sandboxSetTimeout = (
    fn: (...args: unknown[]) => unknown,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (abort.signal.aborted) {
      const id = setTimeout(() => {}, 0);
      clearTimeout(id);
      return id;
    }
    let id: ReturnType<typeof setTimeout>;
    id = setTimeout(() => {
      activeTimers.delete(id);
      if (abort.signal.aborted) return;
      void Promise.resolve(fn(...args)).catch(() => {});
    }, ms);
    activeTimers.add(id);
    id.unref?.();
    return id;
  };
  const sandboxClearTimeout = (id: ReturnType<typeof setTimeout>) => {
    activeTimers.delete(id);
    clearTimeout(id);
  };
  const sandboxSetInterval = (
    fn: (...args: unknown[]) => unknown,
    ms?: number,
    ...args: unknown[]
  ) => {
    if (abort.signal.aborted) {
      const id = setInterval(() => {}, 0);
      clearInterval(id);
      return id;
    }
    let id: ReturnType<typeof setInterval>;
    id = setInterval(() => {
      if (abort.signal.aborted) {
        activeTimers.delete(id);
        clearInterval(id);
        return;
      }
      void Promise.resolve(fn(...args)).catch(() => {});
    }, ms);
    activeTimers.add(id);
    id.unref?.();
    return id;
  };
  const sandboxClearInterval = (id: ReturnType<typeof setInterval>) => {
    activeTimers.delete(id);
    clearInterval(id);
  };
  const timer = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abort.abort();
      reject(new QueryTimeoutError(timeout));
    }, timeout);
    timeoutId.unref?.();
  });

  try {
    const ds = session.createQueryApi({ signal: abort.signal });
    const context = {
      ds,
      pretty: (value: unknown, options?: { maxRows?: number; mode?: "auto" | "table" }) =>
        prettyValue(value, options),
      table: (value: unknown, options?: { maxRows?: number }) => tableValue(value, options),
      console: safeConsole,
      Buffer,
      URL,
      TextEncoder,
      TextDecoder,
      setTimeout: sandboxSetTimeout,
      clearTimeout: sandboxClearTimeout,
      setInterval: sandboxSetInterval,
      clearInterval: sandboxClearInterval,
    };
    let result: unknown;
    try {
      result = script.runInNewContext(context, { timeout, microtaskMode: "afterEvaluate" });
    } catch (error) {
      throw normalizeExecutionError(error, timeout);
    }
    const completion = (async () => {
      if (!isPromiseLike(result)) return result;
      const handledResult = Promise.resolve(result);
      handledResult.catch(() => {});
      const queryState: {
        settled: boolean;
        rejected: boolean;
        value?: unknown;
        error?: unknown;
      } = { settled: false, rejected: false };
      handledResult.then(
        (value) => {
          queryState.settled = true;
          queryState.value = value;
        },
        (error) => {
          queryState.settled = true;
          queryState.rejected = true;
          queryState.error = error;
        },
      );
      while (!queryState.settled && !abort.signal.aborted) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (abort.signal.aborted || queryState.settled) break;
        try {
          drainMicrotasksScript.runInNewContext(context, { timeout, microtaskMode: "afterEvaluate" });
        } catch (error) {
          if (queryState.settled) break;
          throw normalizeExecutionError(error, timeout);
        }
      }
      if (queryState.rejected) throw normalizeExecutionError(queryState.error, timeout);
      return queryState.value;
    })();
    completion.catch(() => {});
    timer.catch(() => {});
    const settled = await Promise.race([completion, timer]);
    if (isQueryEnvelope(settled)) {
      if (settled.__traceServerQueryStatus === "rejected") {
        throw normalizeExecutionError(settled.error, timeout);
      }
      return settled.value;
    }
    return settled;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    abort.abort();
    for (const id of activeTimers) {
      clearTimeout(id);
      clearInterval(id);
    }
    activeTimers.clear();
  }
}
