import { Bytes, Logger } from "@matter/general";
import { ThermostatServer as BaseThermostatServer } from "@matter/main/behaviors";
import {
  AttributeModel,
  type ClusterModel,
  CommandModel,
  FieldModel,
} from "@matter/main/model";
import { ClusterType, TlvAny, type TlvStream } from "@matter/main/types";

const logger = Logger.get("AppleAdaptiveTemp");

// TlvEpochS encodes Unix seconds minus Matter epoch (2000-01-01T00:00:00Z) as uint32.
// Nullable epoch-s reserves 0xffffffff as the null sentinel (Matter.js max = 0xfffffffe).
export const MATTER_EPOCH_S_OFFSET = 946_684_800;
export const MAX_NULLABLE_EPOCH_S = 0xfffffffe + MATTER_EPOCH_S_OFFSET;

export function nowEpochS(): number {
  return Math.max(MATTER_EPOCH_S_OFFSET, Math.floor(Date.now() / 1000));
}

export function toNullableEpochS(rawUnixSec: number): number | null {
  if (!Number.isFinite(rawUnixSec)) {
    return null;
  }
  const truncated = Math.trunc(rawUnixSec);
  return truncated >= MATTER_EPOCH_S_OFFSET
    ? Math.min(MAX_NULLABLE_EPOCH_S, truncated)
    : null;
}

export function isAdaptiveTemperatureEnabled(state: unknown): boolean {
  const s = state as Record<string, unknown>;
  return (
    s.appleAttr0002 !== false &&
    (s.appleAttr0011 as { f0?: boolean } | undefined)?.f0 === true
  );
}

function formatDecodedPayload(value: unknown): string {
  if (value == null) {
    return "null";
  }
  return JSON.stringify(value, (_, v) =>
    typeof v === "bigint"
      ? v.toString()
      : Bytes.isBytes(v)
        ? `0x${Bytes.toHex(v)}`
        : v,
  );
}

// matter.js hands a command of type "any" over as the decoded TlvStream
function decodeApplePayload(
  payload: unknown,
): Record<string, unknown> | undefined {
  if (!Array.isArray(payload)) {
    return undefined;
  }
  try {
    const decoded = TlvAny.decodeAnyTlvStream(payload as TlvStream);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      return decoded as Record<string, unknown>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function logAppleCommand(
  clusterName: string,
  commandId: number,
  commandName: string,
  payloadOrDecoded: unknown,
  alreadyDecoded = false,
) {
  const formatted = alreadyDecoded
    ? formatDecodedPayload(payloadOrDecoded)
    : formatDecodedPayload(
        decodeApplePayload(payloadOrDecoded) ?? payloadOrDecoded,
      );
  logger.debug(
    `[APPLE-MEI] ${clusterName}.${commandName} (0x${commandId.toString(16)}) payload=${formatted}`,
  );
}

export interface ApplePresetParticipationEntry {
  presetHandle: Uint8Array;
  f1: number;
  f2: boolean;
}

export interface AppleAdaptiveTempStatus {
  f0: boolean;
  f1: number | null;
}

export const defaultAppleAttr0010: ApplePresetParticipationEntry[] = [
  { presetHandle: new Uint8Array([1]), f1: 1, f2: true }, // Occupied (At Home)
  { presetHandle: new Uint8Array([2]), f1: 1, f2: true }, // Unoccupied (Away)
  { presetHandle: new Uint8Array([3]), f1: 0, f2: false }, // GoingToSleep
  { presetHandle: new Uint8Array([4]), f1: 1, f2: true }, // Sleep (Night)
  { presetHandle: new Uint8Array([5]), f1: 1, f2: true }, // Vacation (Extended Away)
];

export const defaultAppleAttr0011: AppleAdaptiveTempStatus = {
  f0: true,
  f1: null,
};

function buildAppleThermostatSchema(): ClusterModel {
  const cloned = BaseThermostatServer.schema.clone();
  cloned.children.push(
    new AttributeModel({
      id: 0x13490002,
      name: "AppleAttr0002",
      type: "bool",
      conformance: "M",
      access: "RW VO",
      quality: "N",
      default: true,
    }),
    new AttributeModel({
      id: 0x13490009,
      name: "AppleAttr0009",
      type: "octstr",
      conformance: "M",
      access: "R V",
      quality: "X N",
      default: null,
    }),
    new AttributeModel({
      id: 0x1349000a,
      name: "AppleAttr000A",
      type: "octstr",
      conformance: "M",
      access: "R V",
      quality: "X",
      default: null,
    }),
    new AttributeModel({
      id: 0x1349000b,
      name: "AppleAttr000B",
      type: "epoch-s",
      conformance: "M",
      access: "R V",
      quality: "X N",
      default: null,
    }),
    new AttributeModel({
      id: 0x1349000c,
      name: "AppleAttr000C",
      type: "uint8",
      conformance: "M",
      access: "R V",
      quality: "X N",
      default: null,
    }),
    new AttributeModel({
      id: 0x1349000d,
      name: "AppleAttr000D",
      type: "uint8",
      conformance: "M",
      access: "R V",
      default: 1,
    }),
    new AttributeModel({
      id: 0x1349000e,
      name: "AppleAttr000E",
      type: "bool",
      conformance: "M",
      access: "RW VO",
      quality: "N",
      default: true,
    }),
    new AttributeModel({
      id: 0x1349000f,
      name: "AppleAttr000F",
      type: "uint8",
      conformance: "M",
      access: "R V",
      quality: "N",
      default: 1,
    }),
    new AttributeModel({
      id: 0x13490010,
      name: "AppleAttr0010",
      type: "list",
      conformance: "M",
      access: "RW VO",
      quality: "T N",
      children: [
        new FieldModel({
          name: "entry",
          type: "struct",
          children: [
            new FieldModel({
              id: 0,
              name: "presetHandle",
              type: "octstr",
              conformance: "M",
            }),
            new FieldModel({
              id: 1,
              name: "f1",
              type: "uint8",
              conformance: "M",
            }),
            new FieldModel({
              id: 2,
              name: "f2",
              type: "bool",
              conformance: "M",
            }),
          ],
        }),
      ],
    }),
    new AttributeModel({
      id: 0x13490011,
      name: "AppleAttr0011",
      type: "struct",
      conformance: "M",
      access: "RW VO",
      quality: "N",
      children: [
        new FieldModel({
          id: 0,
          name: "f0",
          type: "bool",
          conformance: "M",
        }),
        new FieldModel({
          id: 1,
          name: "f1",
          type: "uint8",
          conformance: "O",
          quality: "X",
        }),
      ],
    }),
    new AttributeModel({
      id: 0x13490012,
      name: "AppleAttr0012",
      type: "bool",
      conformance: "M",
      access: "RW VO",
      quality: "N",
      default: false,
    }),
    new AttributeModel({
      id: 0x13490013,
      name: "AppleAttr0013",
      type: "bool",
      conformance: "M",
      access: "RW VO",
      quality: "N",
      default: false,
    }),
    new CommandModel({
      id: 0x134900f3,
      name: "AppleCmdF3",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
    new CommandModel({
      id: 0x134900f4,
      name: "AppleCmdF4",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
    new CommandModel({
      id: 0x134900f5,
      name: "AppleCmdF5",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
    new CommandModel({
      id: 0x134900f6,
      name: "AppleCmdF6",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
    new CommandModel({
      id: 0x134900f7,
      name: "AppleCmdF7",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
    new CommandModel({
      id: 0x134900f8,
      name: "AppleCmdF8",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
    new CommandModel({
      id: 0x134900f9,
      name: "AppleCmdF9",
      direction: "request",
      response: "status",
      conformance: "M",
      access: "O",
      type: "any",
    }),
  );
  return cloned;
}

const appleThermostatSchema = buildAppleThermostatSchema();
const ExtendedThermostatBase = BaseThermostatServer.for(
  ClusterType(appleThermostatSchema) as ClusterType,
  appleThermostatSchema,
);

const ExtendedThermostatWithDefaults = ExtendedThermostatBase.set({
  appleAttr0002: true,
  appleAttr0009: null,
  appleAttr000A: null,
  appleAttr000B: null,
  appleAttr000C: null,
  appleAttr000D: 1,
  appleAttr000E: true,
  appleAttr000F: 1,
  appleAttr0010: defaultAppleAttr0010,
  appleAttr0011: defaultAppleAttr0011,
  appleAttr0012: false,
  appleAttr0013: false,
} as Record<string, unknown>);

class AppleThermostatServerImpl extends ExtendedThermostatWithDefaults {
  appleCmdF3(request: unknown) {
    const decoded = decodeApplePayload(request);
    logAppleCommand("Thermostat", 0x134900f3, "appleCmdF3", decoded, true);
    if (!decoded) {
      return;
    }
    if (!("0" in decoded)) {
      logger.debug(
        "[APPLE-MEI] Thermostat.appleCmdF3 missing field 0 (presetHandle); ignoring",
      );
      return;
    }
    const rawHandle = decoded["0"];
    if (rawHandle !== null && !Bytes.isBytes(rawHandle)) {
      logger.debug(
        "[APPLE-MEI] Thermostat.appleCmdF3 invalid field 0 type; ignoring",
      );
      return;
    }
    const presetHandle = Bytes.isBytes(rawHandle)
      ? Bytes.of(rawHandle).slice()
      : null;
    // field 1 is seconds, read from Apple Home captures, there is no spec
    const rawDuration = decoded["1"];
    const durationSec =
      typeof rawDuration === "number" || typeof rawDuration === "bigint"
        ? Math.trunc(Number(rawDuration))
        : undefined;
    const expiryUnixSec =
      durationSec !== undefined && durationSec > 0 && durationSec !== 0xffffffff
        ? toNullableEpochS(Math.floor(Date.now() / 1000) + durationSec)
        : null;

    // Validate/activate standard preset first so an unknown handle throws before
    // mutating Apple MEI tracking attributes.
    const selfWithPreset = this as unknown as {
      setActivePresetRequest?: (req: {
        presetHandle: Uint8Array | null;
      }) => unknown;
    };
    selfWithPreset.setActivePresetRequest?.({ presetHandle });

    const stateObj = this.state as unknown as Record<string, unknown>;
    stateObj.appleAttr0009 = presetHandle;
    stateObj.appleAttr000B = presetHandle ? expiryUnixSec : null;

    logger.debug(
      `[APPLE-MEI] Thermostat.appleCmdF3 applied handle=${presetHandle ? `0x${Bytes.toHex(presetHandle)}` : "null"} expiryUnixSec=${String(stateObj.appleAttr000B)} flag=${String(decoded["2"])}`,
    );
  }

  appleCmdF4(request: unknown) {
    logAppleCommand("Thermostat", 0x134900f4, "appleCmdF4", request);
    const stateObj = this.state as unknown as Record<string, unknown>;
    stateObj.appleAttr0009 = null;
    stateObj.appleAttr000B = null;
    stateObj.appleAttr000C = null;
    stateObj.appleAttr000E = true;
    if (stateObj.temperatureSetpointHold !== undefined) {
      stateObj.temperatureSetpointHold = 0;
    }
    if (stateObj.temperatureSetpointHoldDuration !== undefined) {
      stateObj.temperatureSetpointHoldDuration = null;
    }
    if (stateObj.setpointHoldExpiryTimestamp !== undefined) {
      stateObj.setpointHoldExpiryTimestamp = null;
    }
    const selfWithPreset = this as unknown as {
      setActivePresetRequest?: (req: {
        presetHandle: Uint8Array | null;
      }) => unknown;
    };
    selfWithPreset.setActivePresetRequest?.({ presetHandle: null });
  }

  appleCmdF5(request: unknown) {
    logAppleCommand("Thermostat", 0x134900f5, "appleCmdF5", request);
  }

  appleCmdF6(request: unknown) {
    logAppleCommand("Thermostat", 0x134900f6, "appleCmdF6", request);
  }

  appleCmdF7(request: unknown) {
    logAppleCommand("Thermostat", 0x134900f7, "appleCmdF7", request);
  }

  appleCmdF8(request: unknown) {
    logAppleCommand("Thermostat", 0x134900f8, "appleCmdF8", request);
  }

  appleCmdF9(request: unknown) {
    const decoded = decodeApplePayload(request);
    logAppleCommand("Thermostat", 0x134900f9, "appleCmdF9", decoded, true);
    if (!decoded || typeof decoded["0"] !== "boolean") {
      logger.debug(
        "[APPLE-MEI] Thermostat.appleCmdF9 missing/invalid field 0 (resumeOnNextEvent); ignoring",
      );
      return;
    }
    if (!isAdaptiveTemperatureEnabled(this.state)) {
      logger.debug(
        "[APPLE-MEI] Thermostat.appleCmdF9 ignored because Adaptive Temperature is disabled",
      );
      return;
    }

    const resumeOnNextEvent = decoded["0"];
    // field 1 is minutes, read from Apple Home captures, there is no spec
    const rawDuration = decoded["1"];
    const parsedDuration =
      typeof rawDuration === "number" || typeof rawDuration === "bigint"
        ? Math.trunc(Number(rawDuration))
        : null;
    const durationMinutes =
      parsedDuration !== null &&
      Number.isFinite(parsedDuration) &&
      parsedDuration > 0
        ? Math.min(1440, parsedDuration)
        : null;

    // the Adaptive thermostat classes in thermostat-server.ts carry the hold logic
    const selfWithHold = this as unknown as {
      applyAppleSetpointHold?: (
        resumeOnNextEvent: boolean,
        durationMinutes: number | null,
      ) => void;
    };
    if (!selfWithHold.applyAppleSetpointHold) {
      logger.warn(
        "[APPLE-MEI] Thermostat.appleCmdF9 ignored, no setpoint hold on this server",
      );
      return;
    }
    selfWithHold.applyAppleSetpointHold(resumeOnNextEvent, durationMinutes);

    logger.debug(
      `[APPLE-MEI] Thermostat.appleCmdF9 applied resumeOnNextEvent=${resumeOnNextEvent} durationMinutes=${String(durationMinutes)}`,
    );
  }
}

export const AppleThermostatServerBase =
  AppleThermostatServerImpl as unknown as typeof BaseThermostatServer;
