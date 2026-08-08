import type { Logger } from "@matter/general";
import { callService } from "home-assistant-js-websocket";
import type { HassServiceTarget } from "home-assistant-js-websocket/dist/types.js";
import type { LoggerService } from "../../core/app/logger.js";
import { Service } from "../../core/ioc/service.js";
import { DebounceContext } from "../../utils/debounce-context.js";
import { CircuitBreaker, withRetry } from "../../utils/retry.js";
import { sendHaMessage } from "../../utils/send-ha-message.js";
import { diagnosticEventBus } from "../diagnostics/diagnostic-event-bus.js";
import type { HomeAssistantClient } from "./home-assistant-client.js";

export interface HomeAssistantAction {
  action: string;
  data?: object | undefined;
  /** Optional: Override the target entity ID (defaults to the entity associated with the behavior).
   *  Set to `false` to skip entity targeting entirely (for domain-level services like mqtt.publish). */
  target?: string | false;
}

interface HomeAssistantActionCall extends HomeAssistantAction {
  entityId: string;
}

export interface HomeAssistantActionsConfig {
  retryAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerResetMs?: number;
}

const defaultConfig: Required<HomeAssistantActionsConfig> = {
  retryAttempts: 3,
  retryBaseDelayMs: 100,
  retryMaxDelayMs: 5000,
  circuitBreakerThreshold: 10,
  circuitBreakerResetMs: 30000,
};

export class HomeAssistantActions extends Service {
  private readonly log: Logger;
  private readonly debounceContext = new DebounceContext(
    this.processAction.bind(this),
  );
  private readonly circuitBreaker: CircuitBreaker;
  private readonly config: Required<HomeAssistantActionsConfig>;
  private consecutiveFailures = 0;
  private lastSuccessTime = Date.now();

  constructor(
    logger: LoggerService,
    private readonly client: HomeAssistantClient,
    config?: HomeAssistantActionsConfig,
  ) {
    super("HomeAssistantActions");
    this.log = logger.get(this);
    this.config = { ...defaultConfig, ...config };
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerResetMs,
    );
  }

  private processAction(_key: string, calls: HomeAssistantActionCall[]) {
    // target === false means skip entity targeting (domain-level services like mqtt.publish)
    const skipTarget = calls[0].target === false;
    const entity_id = skipTarget
      ? undefined
      : calls[0].target || calls[0].entityId;
    const action = calls[0].action;
    const data = Object.assign({}, ...calls.map((c) => c.data));
    const [domain, actionName] = action.split(".");
    const target = entity_id ? { entity_id } : {};
    this.callAction(domain, actionName, data, target, false).catch((error) => {
      const errorMsg = this.formatError(error);
      this.log.error(
        `Failed to call action '${action}' for entity '${entity_id ?? "(no target)"}': ${errorMsg}`,
      );
    });
    diagnosticEventBus.emit(
      "command_received",
      `Action ${action} for ${entity_id ?? "(no target)"}`,
      {
        entityId: entity_id ?? calls[0].entityId,
        details: { action, data },
      },
    );
    this.fireEvent("hamh_action", {
      entity_id: entity_id ?? calls[0].entityId,
      action,
      data,
      source: "matter_controller",
    });
  }

  call(action: HomeAssistantAction, entityId: string) {
    // Use the actual target entity for the debounce key so that actions
    // targeting different entities (e.g. suction level vs cleaning mode)
    // are debounced independently instead of being merged incorrectly.
    const target =
      action.target === false ? entityId : (action.target ?? entityId);
    const key = `${target}-${action.action}`;
    this.debounceContext.get(key, 100)({ ...action, entityId });
  }

  async callAction<T = void>(
    domain: string,
    action: string,
    data: object | undefined,
    target: HassServiceTarget,
    returnResponse?: boolean,
  ): Promise<T> {
    const actionKey = `${domain}.${action}`;
    const targetStr = JSON.stringify(target);

    this.log.debug(
      `Calling action '${actionKey}' for target ${targetStr} with data ${JSON.stringify(data ?? {})}`,
    );

    try {
      const result = await this.circuitBreaker.execute(() =>
        withRetry(
          async () => {
            const res = await callService(
              this.client.connection,
              domain,
              action,
              data,
              target,
              returnResponse,
            );
            return res as T;
          },
          {
            maxAttempts: this.config.retryAttempts,
            baseDelayMs: this.config.retryBaseDelayMs,
            maxDelayMs: this.config.retryMaxDelayMs,
            onRetry: (attempt, error, delayMs) => {
              const errorMsg = this.formatError(error);
              this.log.warn(
                `Retrying action '${actionKey}' for ${targetStr} (attempt ${attempt}): ${errorMsg}. Next retry in ${delayMs}ms`,
              );
            },
          },
        ),
      );

      this.onActionSuccess();
      return result;
    } catch (error) {
      this.onActionFailure(actionKey, targetStr, error);
      throw error;
    }
  }

  private onActionSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastSuccessTime = Date.now();
  }

  private formatError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === "object" && error !== null) {
      // Handle HA WebSocket error responses which are plain objects
      const errObj = error as Record<string, unknown>;
      if (errObj.message) return String(errObj.message);
      if (errObj.code) return `Code: ${errObj.code}`;
      try {
        return JSON.stringify(error);
      } catch {
        return "[Complex object]";
      }
    }
    return String(error);
  }

  private onActionFailure(
    action: string,
    target: string,
    error: unknown,
  ): void {
    this.consecutiveFailures++;
    const errorMsg = this.formatError(error);

    if (this.circuitBreaker.isOpen) {
      this.log.error(
        `Circuit breaker OPEN after ${this.consecutiveFailures} consecutive failures. ` +
          `Action '${action}' for ${target} blocked. Last error: ${errorMsg}`,
      );
    } else {
      this.log.error(
        `Action '${action}' for ${target} failed after retries: ${errorMsg}`,
      );
    }
  }

  getHealthStatus(): {
    consecutiveFailures: number;
    circuitBreakerOpen: boolean;
    lastSuccessMs: number;
  } {
    return {
      consecutiveFailures: this.consecutiveFailures,
      circuitBreakerOpen: this.circuitBreaker.isOpen,
      lastSuccessMs: Date.now() - this.lastSuccessTime,
    };
  }

  fireEvent(eventType: string, eventData?: Record<string, unknown>): void {
    sendHaMessage(this.client.connection, {
      type: "fire_event",
      event_type: eventType,
      event_data: eventData,
    }).catch((error) => {
      const errorMsg = this.formatError(error);
      this.log.warn(`Failed to fire event '${eventType}': ${errorMsg}`);
    });
  }

  override async dispose(): Promise<void> {
    this.debounceContext.unregisterAll();
  }
}
