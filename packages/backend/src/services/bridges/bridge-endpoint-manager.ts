import type { FailedEntity } from "@home-assistant-matter-hub/common";
import type { Logger } from "@matter/general";
import type { Endpoint } from "@matter/main";
import { Service } from "../../core/ioc/service.js";
import { AggregatorEndpoint } from "../../matter/endpoints/aggregator-endpoint.js";
import type { EntityEndpoint } from "../../matter/endpoints/entity-endpoint.js";
import { LegacyEndpoint } from "../../matter/endpoints/legacy/legacy-endpoint.js";
import { InvalidDeviceError } from "../../utils/errors/invalid-device-error.js";
import { subscribeEntities } from "../home-assistant/api/subscribe-entities.js";
import type { HomeAssistantClient } from "../home-assistant/home-assistant-client.js";
import type { HomeAssistantStates } from "../home-assistant/home-assistant-registry.js";
import type { BridgeRegistry } from "./bridge-registry.js";

const MAX_ENTITY_ID_LENGTH = 150;

export class BridgeEndpointManager extends Service {
  readonly root: Endpoint;
  private entityIds: string[] = [];
  private unsubscribe?: () => void;
  private _failedEntities: FailedEntity[] = [];

  get failedEntities(): FailedEntity[] {
    return this._failedEntities;
  }

  constructor(
    private readonly client: HomeAssistantClient,
    private readonly registry: BridgeRegistry,
    private readonly log: Logger,
  ) {
    super("BridgeEndpointManager");
    this.root = new AggregatorEndpoint("aggregator");
  }

  override async dispose(): Promise<void> {
    this.stopObserving();
  }

  async startObserving() {
    this.stopObserving();

    if (!this.entityIds.length) {
      return;
    }

    this.unsubscribe = subscribeEntities(
      this.client.connection,
      (e) => this.updateStates(e),
      this.entityIds,
    );
  }

  stopObserving() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  async refreshDevices() {
    this.registry.refresh();
    this._failedEntities = [];

    const endpoints = this.root.parts.map((p) => p as EntityEndpoint);
    this.entityIds = this.registry.entityIds;

    const existingEndpoints: EntityEndpoint[] = [];
    for (const endpoint of endpoints) {
      if (!this.entityIds.includes(endpoint.entityId)) {
        await endpoint.delete();
      } else {
        existingEndpoints.push(endpoint);
      }
    }

    for (const entityId of this.entityIds) {
      if (entityId.length > MAX_ENTITY_ID_LENGTH) {
        const reason = `Entity ID too long (${entityId.length} chars, max ${MAX_ENTITY_ID_LENGTH}). This would cause filesystem errors.`;
        this.log.warn(`Skipping entity: ${entityId}. Reason: ${reason}`);
        this._failedEntities.push({ entityId, reason });
        continue;
      }

      let endpoint = existingEndpoints.find((e) => e.entityId === entityId);
      if (!endpoint) {
        try {
          endpoint = await LegacyEndpoint.create(this.registry, entityId);
        } catch (e) {
          if (e instanceof InvalidDeviceError) {
            const reason = (e as Error).message;
            this.log.warn(
              `Invalid device detected. Entity: ${entityId} Reason: ${reason}`,
            );
            this._failedEntities.push({ entityId, reason });
            continue;
          } else {
            this.log.error(
              `Failed to create device ${entityId}. Error: ${e?.toString()}`,
            );
            throw e;
          }
        }

        if (endpoint) {
          await this.root.add(endpoint);
        }
      }
    }

    if (this.unsubscribe) {
      this.startObserving();
    }
  }

  async updateStates(states: HomeAssistantStates) {
    const endpoints = this.root.parts.map((p) => p as EntityEndpoint);
    for (const endpoint of endpoints) {
      await endpoint.updateStates(states);
    }
  }
}
