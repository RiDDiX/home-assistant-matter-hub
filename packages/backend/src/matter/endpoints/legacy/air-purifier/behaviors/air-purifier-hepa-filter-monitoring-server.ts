import type { FanDeviceAttributes } from "@home-assistant-matter-hub/common";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { numericState } from "../../../../../utils/numeric-state.js";
import {
  type HepaFilterMonitoringConfig,
  HepaFilterMonitoringServer,
} from "../../../../behaviors/hepa-filter-monitoring-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";

const attributes = (entity: { attributes: unknown }) =>
  entity.attributes as FanDeviceAttributes & {
    filter_life?: number;
    filter_life_remaining?: number;
    filter_life_level?: number;
  };

const config: HepaFilterMonitoringConfig = {
  getFilterLifePercent: (entity, agent) => {
    const attrs = attributes(entity);

    // First, try direct attributes on the fan entity
    const directFilterLife =
      numericState(attrs.filter_life) ??
      numericState(attrs.filter_life_remaining) ??
      numericState(attrs.filter_life_level);

    if (directFilterLife != null) {
      return Math.max(0, Math.min(100, directFilterLife));
    }

    // Second, try mapped filter life sensor entity
    const homeAssistant = agent.get(HomeAssistantEntityBehavior);
    const filterLifeEntity = homeAssistant.state.mapping?.filterLifeEntity;

    if (filterLifeEntity) {
      const stateProvider = agent.env.get(EntityStateProvider);
      const sensorValue = stateProvider.getNumericState(filterLifeEntity);
      if (sensorValue != null) {
        return Math.max(0, Math.min(100, sensorValue));
      }
    }

    return null;
  },
};

export const AirPurifierHepaFilterMonitoringServer =
  HepaFilterMonitoringServer(config);
