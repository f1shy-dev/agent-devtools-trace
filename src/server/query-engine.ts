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

async function buildQueryScript(code: string, mode: "expression" | "statements"): Promise<vm.Script> {
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
    script = await buildQueryScript(code, "statements");
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
