import vm from "node:vm";
import ts from "typescript";
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

function transpile(source: string): string {
  const bunRuntime = globalThis.Bun;
  if (bunRuntime) {
    return new bunRuntime.Transpiler({ loader: "ts" }).transformSync(source);
  }

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

function buildQueryScript(code: string, mode: "expression" | "statements"): vm.Script {
  const wrappedCode =
    mode === "expression"
      ? `
        (async () => {
          return (${code});
        })()
      `
      : `
        (async () => {
          ${code}
        })()
      `;
  const jsCode = transpile(wrappedCode);

  return new vm.Script(jsCode);
}

export async function executeQuery(
  session: Session,
  code: string,
  timeout = DEFAULT_QUERY_TIMEOUT,
): Promise<any> {
  const { trace, indexes } = session;
  const events = trace.traceEvents;
  const metadata = trace.metadata;
  const { byCategory, byName, byThread, byPhase } = indexes;

  let script: vm.Script;
  try {
    script = buildQueryScript(code, "expression");
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    script = buildQueryScript(code, "statements");
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
      trace,
      events,
      metadata,
      byCategory,
      byName,
      byThread,
      byPhase,
      Buffer,
      console,
      performance,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
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
