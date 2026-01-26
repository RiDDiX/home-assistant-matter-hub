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

export interface StructuredLogEntry {
  timestamp: string;
  level: string;
  logger: string;
  message: string;
  context?: LogContext;
  error?: {
    name: string;
    message: string;
    stack?: string;
  };
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

export interface StructuredLoggerServiceProps {
  readonly level: string;
  readonly disableColors: boolean;
  readonly jsonOutput?: boolean;
}

export class StructuredLoggerService {
  private readonly _level: LogLevel = MatterLogLevel.INFO;
  private readonly _jsonOutput: boolean;
  private readonly customLogLevelMapping: Record<
    CustomLogLevel,
    MatterLogLevel
  > = {
    [CustomLogLevel.SILLY]: MatterLogLevel.DEBUG,
  };

  constructor(options: StructuredLoggerServiceProps) {
    this._level = logLevelFromString(options.level ?? "info");
    this._jsonOutput = options.jsonOutput ?? false;
    Logger.level =
      this.customLogLevelMapping[this._level as CustomLogLevel] ??
      (this._level as MatterLogLevel);
    Logger.format = options.disableColors ? LogFormat.PLAIN : LogFormat.ANSI;
  }

  get(name: string): StructuredLogger;
  get(name: Service): StructuredLogger;
  get(nameOrService: string | Service): StructuredLogger {
    let name: string;
    if (typeof nameOrService === "string") {
      name = nameOrService;
    } else {
      name = nameOrService.serviceName;
    }
    return new StructuredLogger(name, this._level, this._jsonOutput);
  }
}

export class StructuredLogger extends Logger {
  constructor(
    private readonly loggerName: string,
    private readonly _level: LogLevel,
    private readonly _jsonOutput: boolean = false,
  ) {
    super(loggerName);
  }

  createChild(name: string): StructuredLogger {
    return new StructuredLogger(
      `${this.loggerName} / ${name}`,
      this._level,
      this._jsonOutput,
    );
  }

  silly(message: string, context?: LogContext): void {
    if (this._level <= CustomLogLevel.SILLY) {
      this.logStructured(CustomLogLevel.SILLY, message, context);
    }
  }

  debugCtx(message: string, context?: LogContext): void {
    if (this._level <= MatterLogLevel.DEBUG) {
      this.logStructured(MatterLogLevel.DEBUG, message, context);
    }
  }

  infoCtx(message: string, context?: LogContext): void {
    if (this._level <= MatterLogLevel.INFO) {
      this.logStructured(MatterLogLevel.INFO, message, context);
    }
  }

  warnCtx(message: string, context?: LogContext): void {
    if (this._level <= MatterLogLevel.WARN) {
      this.logStructured(MatterLogLevel.WARN, message, context);
    }
  }

  errorCtx(message: string, error?: Error, context?: LogContext): void {
    if (this._level <= MatterLogLevel.ERROR) {
      this.logStructured(MatterLogLevel.ERROR, message, context, error);
    }
  }

  private logStructured(
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: Error,
  ): void {
    if (this._jsonOutput) {
      const entry: StructuredLogEntry = {
        timestamp: new Date().toISOString(),
        level: logLevelToString(level),
        logger: this.loggerName,
        message,
      };
      if (context && Object.keys(context).length > 0) {
        entry.context = context;
      }
      if (error) {
        entry.error = {
          name: error.name,
          message: error.message,
          stack: error.stack,
        };
      }
      console.log(JSON.stringify(entry));
    } else {
      // Fall back to standard logging with context appended
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
