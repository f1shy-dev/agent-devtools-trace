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

function buildQueryFunction(code: string, mode: "expression" | "statements") {
  const wrappedCode =
    mode === "expression"
      ? `return (async () => { return (${code}); })();`
      : `return (async () => { ${code} })();`;
  const jsCode = transpile(wrappedCode);

  return new Function(
    "trace",
    "events",
    "metadata",
    "byCategory",
    "byName",
    "byThread",
    "byPhase",
    jsCode,
  );
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

  let fn: Function;
  try {
    fn = buildQueryFunction(code, "expression");
  } catch (error) {
    if (!(error instanceof SyntaxError)) {
      throw error;
    }
    fn = buildQueryFunction(code, "statements");
  }

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new QueryTimeoutError(timeout));
    }, timeout);
    timeoutId.unref?.();
  });

  try {
    return await Promise.race([
      Promise.resolve(fn(trace, events, metadata, byCategory, byName, byThread, byPhase)),
      timer,
    ]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
  }
}
