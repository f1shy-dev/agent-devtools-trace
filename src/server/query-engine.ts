import ts from "typescript";
import { DEFAULT_QUERY_TIMEOUT } from "../shared/constants";
import type { Session } from "../shared/types";

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

  const timer = new Promise((_, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Query timed out after ${timeout}ms`));
    }, timeout);
    timeoutId.unref?.();
  });

  return Promise.race([
    Promise.resolve(fn(trace, events, metadata, byCategory, byName, byThread, byPhase)),
    timer,
  ]);
}
