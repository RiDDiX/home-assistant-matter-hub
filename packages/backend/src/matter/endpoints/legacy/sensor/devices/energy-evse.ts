import { Logger } from "@matter/general";
import {
  DescriptorServer,
  EnergyEvseServer as EvseBase,
  EnergyEvseModeServer as EvseModeBase,
  PowerSourceServer as PowerSourceBase,
} from "@matter/main/behaviors";
import { EnergyEvse, EnergyEvseMode, PowerSource } from "@matter/main/clusters";
import { EnergyEvseDevice } from "@matter/main/devices";
import { DeviceTypeId } from "@matter/main/types";
import { EntityStateProvider } from "../../../../../services/bridges/entity-state-provider.js";
import { HomeAssistantActions } from "../../../../../services/home-assistant/home-assistant-actions.js";
import { applyPatchState } from "../../../../../utils/apply-patch-state.js";
import { BasicInformationServer } from "../../../../behaviors/basic-information-server.js";
import { HomeAssistantEntityBehavior } from "../../../../behaviors/home-assistant-entity-behavior.js";
import { IdentifyServer } from "../../../../behaviors/identify-server.js";
import { HaPowerTopologyServer } from "../../../../behaviors/power-topology-server.js";
import { EnergyServer, PowerServer } from "./electrical-sensor.js";

const logger = Logger.get("EnergyEvse");

import { mapEvseStatus } from "./evse-status.js";

// The current attributes are mA. Seed sane defaults so the cluster never
// reports an implicit 0 A limit before HA feeds a live value.
const MIN_CHARGE_CURRENT_MA = 6000;
const MAX_CHARGE_CURRENT_MA = 32000;
const CIRCUIT_CAPACITY_MA = 32000;

// setTimeout truncates delays beyond ~24.8 days to 32-bit, firing immediately.
const MAX_TIMER_MS = 2_147_483_647;

function clampMa(ma: number): number {
  return Math.min(CIRCUIT_CAPACITY_MA, Math.max(MIN_CHARGE_CURRENT_MA, ma));
}

// matter.js runs each controller command on a throwaway proxy instance, so an
// instance field can't survive to a later setTimeout. Keep the charge-window
// expiry timer keyed on the persistent Endpoint object instead (cover-server
// precedent), cleared on a fresh enableCharging / disable / dispose.
const evseChargingTimers = new WeakMap<object, ReturnType<typeof setTimeout>>();

function clearEvseChargingTimer(endpoint: object) {
  const timer = evseChargingTimers.get(endpoint);
  if (timer) {
    clearTimeout(timer);
    evseChargingTimers.delete(endpoint);
  }
}

// Drives the EnergyEvse cluster from the mapped charger STATUS entity and
// implements the EnableCharging / Disable commands (the default
// EnergyEvseServer leaves them unimplemented, so without these overrides the
// acceptedCommandList would stay empty). Charging is started/stopped through
// the mapped switch, and the charge current through the mapped number entity.
class EvseStatusServer extends EvseBase {
  override async initialize() {
    await super.initialize();
    const homeAssistant = await this.agent.load(HomeAssistantEntityBehavior);
    this.update();
    this.reactTo(homeAssistant.onChange, this.update, {
      offline: true,
      lock: true,
    });
  }

  override async [Symbol.asyncDispose]() {
    // this.endpoint is valid on the dispose instance, so this clears the real
    // timer held in the registry (the fields on this instance never held it).
    clearEvseChargingTimer(this.endpoint);
    await super[Symbol.asyncDispose]();
  }

  private chargingSwitchIsOn(): boolean {
    const mapping = this.agent.get(HomeAssistantEntityBehavior).state.mapping;
    const switchEntity = mapping?.chargingSwitchEntity;
    if (!switchEntity) return false;
    const stateProvider = this.agent.env.get(EntityStateProvider);
    return stateProvider.getState(switchEntity)?.state === "on";
  }

  private update() {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const raw = homeAssistant.entity.state?.state ?? "";
    const status = mapEvseStatus(raw, this.chargingSwitchIsOn());

    const patch: {
      state: EnergyEvse.State | null;
      supplyState: EnergyEvse.SupplyState;
      faultState: EnergyEvse.FaultState;
      maximumChargeCurrent?: number;
    } = {
      state: status.state,
      supplyState: status.supplyState,
      faultState: status.faultState,
    };

    // A mapped current-limit number entity (A) feeds MaximumChargeCurrent (mA),
    // clamped to the advertised circuit range so a stray 80 A reading can't
    // advertise more than the wallbox can deliver.
    const mapping = homeAssistant.state.mapping;
    if (mapping?.currentLimitEntity) {
      const stateProvider = this.agent.env.get(EntityStateProvider);
      const amps = stateProvider.getNumericState(mapping.currentLimitEntity);
      if (amps != null) {
        patch.maximumChargeCurrent = clampMa(Math.round(amps * 1000));
      }
    }

    applyPatchState(this.state, patch);
  }

  override enableCharging(request: EnergyEvse.EnableChargingRequest) {
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const mapping = homeAssistant.state.mapping;

    // matter.js decodes the epoch-s field through TlvEpochS, which already adds
    // the Matter->unix offset, so this is a unix epoch in seconds. Do NOT add
    // the offset again here (that would push expiry ~30 years out).
    const until = request.chargingEnabledUntil;

    // A window that already elapsed is a stop request, not a start.
    if (until != null && until * 1000 <= Date.now()) {
      this.disable();
      return;
    }

    // A fresh command supersedes any pending expiry.
    clearEvseChargingTimer(this.endpoint);

    let dispatched = false;
    if (mapping?.chargingSwitchEntity) {
      homeAssistant.callAction({
        action: "switch.turn_on",
        target: mapping.chargingSwitchEntity,
      });
      dispatched = true;
    }

    const maxCurrent = request.maximumChargeCurrent;
    if (mapping?.currentLimitEntity && maxCurrent != null) {
      // Clamp in mA first and floor, never exceed the requested bound.
      const amps = Math.max(
        MIN_CHARGE_CURRENT_MA / 1000,
        Math.floor(clampMa(Number(maxCurrent)) / 1000),
      );
      homeAssistant.callAction({
        action: "number.set_value",
        target: mapping.currentLimitEntity,
        data: { value: amps },
      });
      dispatched = true;
    }

    // Optimistic only when something actually happened; a status-only EVSE
    // must not report ChargingEnabled for a no-op.
    if (!dispatched) {
      logger.debug(
        `enableCharging ignored for ${homeAssistant.entityId}: no charging switch or current limit mapped`,
      );
      return;
    }

    const patch: {
      supplyState: EnergyEvse.SupplyState;
      chargingEnabledUntil: number | null;
      minimumChargeCurrent?: number;
      maximumChargeCurrent?: number;
    } = {
      supplyState: EnergyEvse.SupplyState.ChargingEnabled,
      chargingEnabledUntil: until ?? null,
    };
    if (request.minimumChargeCurrent != null) {
      patch.minimumChargeCurrent = clampMa(
        Number(request.minimumChargeCurrent),
      );
    }
    if (maxCurrent != null) {
      patch.maximumChargeCurrent = clampMa(Number(maxCurrent));
    }
    applyPatchState(this.state, patch);

    // Arm the expiry that stops charging when the window ends. No agent context
    // survives the timer, so capture plain values and write through the
    // persistent endpoint (window-covering pattern).
    if (until != null) {
      const delay = until * 1000 - Date.now();
      // Skip a far-future window rather than fire early and stop prematurely.
      if (delay > 0 && delay <= MAX_TIMER_MS) {
        const endpoint = this.endpoint;
        const actions = this.env.get(HomeAssistantActions);
        const entityId = homeAssistant.entityId;
        const switchEntity = mapping?.chargingSwitchEntity;
        const timer = setTimeout(() => {
          void (async () => {
            try {
              // Only the current owner may write; a fresh EnableCharging
              // replaces the map entry and this callback must then no-op.
              if (evseChargingTimers.get(endpoint) !== timer) return;
              if (switchEntity) {
                actions.call(
                  { action: "switch.turn_off", target: switchEntity },
                  entityId,
                );
              }
              await endpoint.setStateOf(EvseStatusServer, {
                supplyState: EnergyEvse.SupplyState.Disabled,
                chargingEnabledUntil: null,
              });
            } catch (error) {
              logger.debug(
                `EVSE charge-window expiry write failed (endpoint may be closing): ${error}`,
              );
            } finally {
              if (evseChargingTimers.get(endpoint) === timer) {
                evseChargingTimers.delete(endpoint);
              }
            }
          })();
        }, delay);
        // A safety net must not keep the event loop alive by itself.
        (timer as { unref?: () => void }).unref?.();
        evseChargingTimers.set(endpoint, timer);
      }
    }
  }

  override disable() {
    clearEvseChargingTimer(this.endpoint);
    const homeAssistant = this.agent.get(HomeAssistantEntityBehavior);
    const mapping = homeAssistant.state.mapping;

    if (mapping?.chargingSwitchEntity) {
      homeAssistant.callAction({
        action: "switch.turn_off",
        target: mapping.chargingSwitchEntity,
      });
    }
    // Mirror enableCharging: anything it can enable, disable must reset,
    // including a current-limit-only EVSE that has no switch.
    if (mapping?.chargingSwitchEntity || mapping?.currentLimitEntity) {
      applyPatchState(this.state, {
        supplyState: EnergyEvse.SupplyState.Disabled,
        chargingEnabledUntil: null,
      });
    } else {
      logger.debug(
        `disable ignored for ${homeAssistant.entityId}: no charging switch mapped`,
      );
    }
  }
}

// supplyState and faultState are non-nullable enum8 without defaults, so the
// endpoint bricks on mount unless both are seeded. State/sessionId/etc are
// nullable and auto-null.
const EvseStatusSeeded = EvseStatusServer.set({
  supplyState: EnergyEvse.SupplyState.Disabled,
  faultState: EnergyEvse.FaultState.NoError,
  circuitCapacity: CIRCUIT_CAPACITY_MA,
  minimumChargeCurrent: MIN_CHARGE_CURRENT_MA,
  maximumChargeCurrent: MAX_CHARGE_CURRENT_MA,
});

// EnergyEvseMode is mandatory. The server asserts a Manual mode tag, so seed a
// single Manual mode and select it. Features stay off (no charging preferences).
// Modes count from 0: SmartThings addresses them by list position (#475).
class EvseModeServer extends EvseModeBase {
  override async initialize() {
    // A persisted currentMode from before the renumbering would fail the mount.
    const modes = this.state.supportedModes;
    if (
      modes.length > 0 &&
      !modes.some((m) => m.mode === this.state.currentMode)
    ) {
      this.state.currentMode = modes[0].mode;
    }
    await super.initialize();
  }
}

const EvseModeSeeded = EvseModeServer.set({
  supportedModes: [
    {
      label: "Manual",
      mode: 0,
      modeTags: [{ value: EnergyEvseMode.ModeTag.Manual }],
    },
  ],
  currentMode: 0,
});

// The EnergyEvse device type mandates a PowerSource. A wallbox is mains-powered,
// so mount the Wired variant and seed its mandatory attrs (Status, Order,
// Description are M; WiredCurrentType is M once the WIRED feature is on).
const WiredPowerSourceBase = PowerSourceBase.with("Wired");

class EvsePowerSourceServer extends WiredPowerSourceBase {
  override async initialize() {
    await super.initialize();
    // EndpointList is mandatory; controllers need this endpoint's number to
    // associate the power source with the device.
    const endpointNumber = this.endpoint.number;
    if (endpointNumber != null) {
      applyPatchState(this.state, { endpointList: [endpointNumber] });
    }
  }
}

const EvsePowerSource = EvsePowerSourceServer.set({
  status: PowerSource.PowerSourceStatus.Active,
  order: 0,
  description: "Mains",
  wiredCurrentType: PowerSource.WiredCurrentType.Ac,
});

// EnergyEvse (0x050C) plus the ElectricalSensor (0x0510) device type, since the
// endpoint carries the measurement clusters (SmartThings needs each device type
// listed to render them, #214). DescriptorServer must be mounted explicitly for
// the deviceTypeList default below to apply; matter.js then appends the
// cluster-derived types (PowerSource, BridgedNode).
const EnergyEvseBase = EnergyEvseDevice.with(
  BasicInformationServer,
  IdentifyServer,
  HomeAssistantEntityBehavior,
  EvseStatusSeeded,
  EvseModeSeeded,
  EvsePowerSource,
  // Always mount the measurement clusters; both seed safe defaults when no
  // power/energy entity is mapped, so the endpoint honestly carries the
  // ElectricalSensor device type.
  PowerServer,
  EnergyServer,
  // ElectricalSensor requires PowerTopology; matter.js does not enforce it.
  HaPowerTopologyServer,
  DescriptorServer,
).set({
  descriptor: {
    deviceTypeList: [
      { deviceType: DeviceTypeId(0x050c), revision: 2 },
      { deviceType: DeviceTypeId(0x0510), revision: 1 },
    ],
  },
});

// EnergyEvse (0x050C) driven by a charger status entity, with the stage 1
// measurement clusters folded onto the same endpoint.
export function energyEvseType() {
  // The spec also lists a DeviceEnergyManagement device type, but HA exposes no
  // charging forecast/schedule to feed it honestly and every controller tested
  // so far renders the EVSE without it, so it is deliberately omitted.
  return EnergyEvseBase;
}
