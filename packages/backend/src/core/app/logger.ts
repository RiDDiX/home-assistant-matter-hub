import {
  LogDestination,
  LogFormat,
  Logger,
  LogLevel as MatterLogLevel,
} from "@matter/general";
import { addLogEntry } from "../../api/logs-api.js";
import type { Service } from "../ioc/service.js";

export enum CustomLogLevel {
  SILLY = -1,
}

export type LogLevel = CustomLogLevel | MatterLogLevel;
type LogLevelName = keyof (typeof CustomLogLevel & typeof MatterLogLevel);

export interface LogContext {
  [key: string]: unknown;
}

// matter.js facility names that carry controller traffic.
export const MATTER_TRAFFIC_FACILITIES = new Set([
  "InteractionServer",
  "MessageExchange",
  "MessageChannel",
  "ServerSubscription",
  "IncomingInteractionServerMessenger",
  "ExchangeManager",
  // Rejected invokes (UnsupportedEndpoint and friends) log here at INFO; a
  // controller aiming at a stale endpoint number is invisible without it (#423).
  "CommandInvokeResponse",
]);

export function categoryFor(facility: string): string | undefined {
  return MATTER_TRAFFIC_FACILITIES.has(facility) ? "matter-traffic" : undefined;
}

function logLevelFromString(
  level: LogLevelName | string,
): CustomLogLevel | MatterLogLevel {
  const customNames: Record<keyof typeof CustomLogLevel, CustomLogLevel> = {
    SILLY: CustomLogLevel.SILLY,
  };
  if (level.toUpperCase() in customNames) {
    return customNames[level.toUpperCase() as keyof typeof CustomLogLevel];
  }
  return MatterLogLevel(level);
}

function logLevelToString(level: LogLevel): string {
  if (level === CustomLogLevel.SILLY) return "SILLY";
  switch (level) {
    case MatterLogLevel.DEBUG:
      return "DEBUG";
    case MatterLogLevel.INFO:
      return "INFO";
    case MatterLogLevel.NOTICE:
      return "NOTICE";
    case MatterLogLevel.WARN:
      return "WARN";
    case MatterLogLevel.ERROR:
      return "ERROR";
    case MatterLogLevel.FATAL:
      return "FATAL";
    default:
      return "UNKNOWN";
  }
}

export interface LoggerServiceProps {
  readonly level: string;
  readonly protocolLevel?: string;
  readonly disableColors: boolean;
  readonly jsonOutput?: boolean;
}

export class LoggerService {
  private readonly _level: LogLevel = MatterLogLevel.INFO;
  private readonly _jsonOutput: boolean;
  private readonly customLogLevelMapping: Record<
    CustomLogLevel,
    MatterLogLevel
  > = {
    [CustomLogLevel.SILLY]: MatterLogLevel.DEBUG,
  };

  constructor(options: LoggerServiceProps) {
    this._level = logLevelFromString(options.level ?? "info");
    this._jsonOutput = options.jsonOutput ?? false;
    Logger.level =
      this.customLogLevelMapping[this._level as CustomLogLevel] ??
      (this._level as MatterLogLevel);
    // quiet matter.js packet-payload facilities unless explicitly asked for
    const protocolLevel = logLevelFromString(options.protocolLevel ?? "info");
    const resolvedProtocolLevel =
      this.customLogLevelMapping[protocolLevel as CustomLogLevel] ??
      (protocolLevel as MatterLogLevel);
    Logger.facilityLevels = {
      MessageChannel: resolvedProtocolLevel,
      MessageExchange: resolvedProtocolLevel,
    };
    Logger.format = options.disableColors ? LogFormat.PLAIN : LogFormat.ANSI;

    // Forward matter.js traffic logs into the in-memory buffer.
    const destinationLevel =
      this.customLogLevelMapping[this._level as CustomLogLevel] ??
      (this._level as MatterLogLevel);
    Logger.destinations["hamh-buffer"] = LogDestination({
      name: "hamh-buffer",
      level: destinationLevel,
      facilityLevels: {
        MessageChannel: resolvedProtocolLevel,
        MessageExchange: resolvedProtocolLevel,
      },
      write: (text, message) => {
        const category = categoryFor(message.facility);
        if (!category) return;
        addLogEntry({
          timestamp: message.now.toISOString(),
          level: logLevelToString(message.level).toLowerCase(),
          message: text,
          facility: message.facility,
          category,
        });
      },
    });
  }

  get(name: string): BetterLogger;
  get(name: Service): BetterLogger;
  get(nameOrService: string | Service): BetterLogger {
    let name: string;
    if (typeof nameOrService === "string") {
      name = nameOrService;
    } else {
      name = nameOrService.serviceName;
    }
    return new BetterLogger(name, this._level, this._jsonOutput);
  }
}

export class BetterLogger extends Logger {
  constructor(
    private readonly loggerName: string,
    private readonly _level: LogLevel,
    private readonly _jsonOutput: boolean = false,
  ) {
    super(loggerName);
  }

  createChild(name: string) {
    return new BetterLogger(
      `${this.loggerName} / ${name}`,
      this._level,
      this._jsonOutput,
    );
  }

  silly(...values: unknown[]): void {
    if (this._level <= CustomLogLevel.SILLY) {
      this.debug(...["SILLY", ...values]);
    }
  }

  override debug(...values: unknown[]): void {
    if (this._level <= MatterLogLevel.DEBUG) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: "debug",
        message: `[${this.loggerName}] ${values.map((v) => String(v)).join(" ")}`,
      });
    }
    super.debug(...values);
  }

  override info(...values: unknown[]): void {
    if (this._level <= MatterLogLevel.INFO) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: "info",
        message: `[${this.loggerName}] ${values.map((v) => String(v)).join(" ")}`,
      });
    }
    super.info(...values);
  }

  override warn(...values: unknown[]): void {
    if (this._level <= MatterLogLevel.WARN) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: "warn",
        message: `[${this.loggerName}] ${values.map((v) => String(v)).join(" ")}`,
      });
    }
    super.warn(...values);
  }

  override error(...values: unknown[]): void {
    if (this._level <= MatterLogLevel.ERROR) {
      addLogEntry({
        timestamp: new Date().toISOString(),
        level: "error",
        message: `[${this.loggerName}] ${values.map((v) => String(v)).join(" ")}`,
      });
    }
    super.error(...values);
  }

  debugCtx(message: string, context?: LogContext): void {
    if (this._level <= MatterLogLevel.DEBUG) {
      this.logWithContext(MatterLogLevel.DEBUG, message, context);
    }
  }

  infoCtx(message: string, context?: LogContext): void {
    if (this._level <= MatterLogLevel.INFO) {
      this.logWithContext(MatterLogLevel.INFO, message, context);
    }
  }

  warnCtx(message: string, context?: LogContext): void {
    if (this._level <= MatterLogLevel.WARN) {
      this.logWithContext(MatterLogLevel.WARN, message, context);
    }
  }

  errorCtx(message: string, error?: Error, context?: LogContext): void {
    if (this._level <= MatterLogLevel.ERROR) {
      this.logWithContext(MatterLogLevel.ERROR, message, context, error);
    }
  }

  private logWithContext(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error,
  ): void {
    const levelStr = logLevelToString(level).toLowerCase();
    const timestamp = new Date().toISOString();

    // Add to log buffer for API access
    addLogEntry({
      timestamp,
      level: levelStr,
      message: `[${this.loggerName}] ${message}`,
      context: {
        ...context,
        ...(error ? { error: error.message, stack: error.stack } : {}),
      },
    });

    if (this._jsonOutput) {
      const entry = {
        timestamp,
        level: logLevelToString(level),
        logger: this.loggerName,
        message,
        ...(context && Object.keys(context).length > 0 ? { context } : {}),
        ...(error
          ? {
              error: {
                name: error.name,
                message: error.message,
                stack: error.stack,
              },
            }
          : {}),
      };
      console.log(JSON.stringify(entry));
    } else {
      let logMessage = message;
      if (context && Object.keys(context).length > 0) {
        logMessage += ` ${JSON.stringify(context)}`;
      }
      if (error) {
        logMessage += ` Error: ${error.message}`;
      }

      switch (level) {
        case CustomLogLevel.SILLY:
        case MatterLogLevel.DEBUG:
          super.debug(logMessage);
          break;
        case MatterLogLevel.INFO:
        case MatterLogLevel.NOTICE:
          super.info(logMessage);
          break;
        case MatterLogLevel.WARN:
          super.warn(logMessage);
          break;
        case MatterLogLevel.ERROR:
        case MatterLogLevel.FATAL:
          super.error(logMessage);
          break;
      }
    }
  }
}
