// HA's websocket rejects with a plain { code, message } object
export function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  const { code, message } = (err ?? {}) as {
    code?: unknown;
    message?: unknown;
  };
  if (message !== undefined) return code ? `${code}: ${message}` : `${message}`;
  return String(err);
}
