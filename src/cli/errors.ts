export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isConnectionError(error: unknown): boolean {
  const message = getErrorMessage(error);
  return ["connect", "ECONNREFUSED", "ENOENT", "socket", "Server failed to start"].some((part) =>
    message.includes(part),
  );
}

export function fail(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}

export function handleCommandError(error: unknown): never {
  if (isConnectionError(error)) {
    fail("Server is not running. Use 'trace-server load <file>' to start.");
  }
  fail(`Error: ${getErrorMessage(error)}`);
}
