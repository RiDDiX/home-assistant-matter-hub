import { LogFormat, Logger, LogLevel as MatterLogLevel } from "@matter/general";
import type { Service } from "../ioc/service.js";

export enum CustomLogLevel {
  SILLY = -1,
}

export type LogLevel = CustomLogLevel | MatterLogLevel;
type LogLevelName = keyof (typeof CustomLogLevel & typeof MatterLogLevel);

export interface LogContext {
  [key: string]: unknown;
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
    Logger.format = options.disableColors ? LogFormat.PLAIN : LogFormat.ANSI;
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
    if (this._jsonOutput) {
      const entry = {
        timestamp: new Date().toISOString(),
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
          this.debug(logMessage);
          break;
        case MatterLogLevel.INFO:
        case MatterLogLevel.NOTICE:
          this.info(logMessage);
          break;
        case MatterLogLevel.WARN:
          this.warn(logMessage);
          break;
        case MatterLogLevel.ERROR:
        case MatterLogLevel.FATAL:
          this.error(logMessage);
          break;
      }
    }
  }
}
