import {
  type Connection,
  createConnection,
  createLongLivedTokenAuth,
  ERR_CANNOT_CONNECT,
  ERR_INVALID_AUTH,
  getConfig,
} from "home-assistant-js-websocket";
import type { BetterLogger, LoggerService } from "../../core/app/logger.js";
import { Service } from "../../core/ioc/service.js";
import { withRetry } from "../../utils/retry.js";

// Treat DNS / routing / TLS hiccups the same as ERR_CANNOT_CONNECT: log and
// retry instead of crashing startup. The HA WS library only emits
// ERR_CANNOT_CONNECT for its own connect-phase failures; Node raises its own
// error codes (ENOTFOUND, ECONNRESET, etc.) on the underlying socket.
const TRANSIENT_CONNECT_ERROR_CODES = new Set<string>([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);
export function isTransientConnectError(reason: unknown): boolean {
  if (reason === ERR_CANNOT_CONNECT) return true;
  const code = (reason as NodeJS.ErrnoException | undefined)?.code;
  if (code && TRANSIENT_CONNECT_ERROR_CODES.has(code)) return true;
  const msg = reason instanceof Error ? reason.message : String(reason);
  return (
    msg.includes("socket hang up") || msg.includes("tls") || msg.includes("TLS")
  );
}

export interface HomeAssistantClientProps {
  readonly url: string;
  readonly accessToken: string;
  readonly refreshInterval: number;
  readonly messageTimeoutMs: number;
}

export class HomeAssistantClient extends Service {
  static Options = Symbol.for("HomeAssistantClientProps");

  private _connection!: Connection;
  private readonly log: BetterLogger;

  get connection(): Connection {
    return this._connection;
  }

  get baseUrl(): string {
    return this.options.url;
  }

  get accessToken(): string {
    return this.options.accessToken;
  }

  constructor(
    logger: LoggerService,
    private readonly options: HomeAssistantClientProps,
  ) {
    super("HomeAssistantClient");
    this.log = logger.get(this);
  }

  protected override async initialize() {
    this._connection = await this.createConnection(this.options);
  }

  override async dispose() {
    this.connection?.close();
  }

  private async createConnection(
    props: HomeAssistantClientProps,
  ): Promise<Connection> {
    const maxConnectAttempts = 60; // 5 minutes with 5s delay
    for (let attempt = 1; attempt <= maxConnectAttempts; attempt++) {
      try {
        const connection = await createConnection({
          auth: createLongLivedTokenAuth(
            props.url.replace(/\/$/, ""),
            props.accessToken,
          ),
        });
        await this.waitForHomeAssistantToBeUpAndRunning(connection);
        return connection;
      } catch (reason: unknown) {
        if (reason === ERR_INVALID_AUTH) {
          this.log.errorCtx(
            "Authentication failed",
            new Error("Invalid authentication credentials"),
            { url: props.url },
          );
          throw new Error(
            "Authentication failed while connecting to home assistant",
          );
        }
        if (isTransientConnectError(reason)) {
          this.log.warnCtx("Unable to connect to Home Assistant, retrying...", {
            url: props.url,
            attempt,
            maxAttempts: maxConnectAttempts,
            retryDelayMs: 5000,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        }
        throw new Error(`Unable to connect to home assistant: ${reason}`);
      }
    }
    throw new Error(
      `Failed to connect to Home Assistant at ${props.url} after ${maxConnectAttempts} attempts (5 minutes)`,
    );
  }

  private async waitForHomeAssistantToBeUpAndRunning(
    connection: Connection,
  ): Promise<void> {
    this.log.infoCtx("Waiting for Home Assistant to be up and running", {
      message: "Application will be available once connection is established",
    });

    const getState = async () => {
      const state = await withRetry(
        () => getConfig(connection).then((config) => config.state),
        {
          maxAttempts: 3,
          baseDelayMs: 1000,
          onRetry: (attempt, error) => {
            this.log.debugCtx("Retrying Home Assistant state check", {
              attempt,
              error: error instanceof Error ? error.message : String(error),
            });
          },
        },
      );
      this.log.debugCtx("Home Assistant state update", { state });
      return state;
    };

    const maxWaitAttempts = 120; // 10 minutes with 5s delay
    let state: string | undefined;
    let waitAttempt = 0;
    while (state !== "RUNNING") {
      if (++waitAttempt > maxWaitAttempts) {
        throw new Error(
          `Home Assistant did not reach RUNNING state within 10 minutes (last state: ${state ?? "unknown"})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
      state = await getState();
    }
    this.log.infoCtx("Home Assistant is up and running", { state });
  }
}
