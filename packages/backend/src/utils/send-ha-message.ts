import type { Connection } from "home-assistant-js-websocket";

export const HA_MESSAGE_TIMEOUT_MS = 60_000;

/**
 * Wrap `connection.sendMessagePromise` with a hard timeout so a hung or
 * unresponsive HA instance can't freeze the caller forever.
 */
export function sendHaMessage<T>(
  connection: Connection,
  message: { type: string; [key: string]: unknown },
  timeoutMs: number = HA_MESSAGE_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `HA message '${message.type}' timed out after ${timeoutMs}ms`,
        ),
      );
    }, timeoutMs);
  });
  return Promise.race([
    connection.sendMessagePromise<T>(message),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}
