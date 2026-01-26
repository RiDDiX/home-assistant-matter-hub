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

export interface HomeAssistantClientProps {
  readonly url: string;
  readonly accessToken: string;
  readonly refreshInterval: number;
}

export class HomeAssistantClient extends Service {
  static Options = Symbol.for("HomeAssistantClientProps");

  private _connection!: Connection;
  private readonly log: BetterLogger;

  get connection(): Connection {
    return this._connection;
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
      return this.handleInitializationError(reason, props);
    }
  }

  private async handleInitializationError(
    reason: unknown,
    props: HomeAssistantClientProps,
  ): Promise<Connection> {
    if (reason === ERR_CANNOT_CONNECT) {
      this.log.warnCtx("Unable to connect to Home Assistant, retrying...", {
        url: props.url,
        retryDelayMs: 5000,
      });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return this.createConnection(props);
    }
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
    throw new Error(`Unable to connect to home assistant: ${reason}`);
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
              error: error.message,
            });
          },
        },
      );
      this.log.debugCtx("Home Assistant state update", { state });
      return state;
    };

    let state: string | undefined;
    while (state !== "RUNNING") {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      state = await getState();
    }
    this.log.infoCtx("Home Assistant is up and running", { state });
  }
}
