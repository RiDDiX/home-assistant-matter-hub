import {
  type BridgeBasicInformation,
  type BridgeData,
  type BridgeFeatureFlags,
  type BridgeIconType,
  type BridgeStatus,
  controllerWarningsForFabrics,
  type ExposedDeviceType,
  type FailedEntity,
  type HomeAssistantFilter,
  type UpdateBridgeRequest,
} from "@home-assistant-matter-hub/common";
import type { ServerNode } from "@matter/main/node";
import { values } from "lodash-es";
import { Service } from "../../core/ioc/service.js";

export interface BridgeServerStatus {
  code: BridgeStatus;
  reason?: string;
}

export class BridgeDataProvider extends Service implements BridgeData {
  private readonly data: BridgeData;

  constructor(initial: BridgeData) {
    super("BridgeDataProvider");
    this.data = Object.assign({}, initial);
  }

  /************************************************
   * BridgeData interface
   ************************************************/
  get id(): string {
    return this.data.id;
  }
  get basicInformation(): BridgeBasicInformation {
    return this.data.basicInformation;
  }
  get name(): string {
    return this.data.name;
  }
  get port(): number {
    return this.data.port;
  }
  get filter(): HomeAssistantFilter {
    return this.data.filter;
  }
  get featureFlags(): BridgeFeatureFlags | undefined {
    return this.data.featureFlags;
  }
  get countryCode(): string | undefined {
    return this.data.countryCode;
  }
  get icon(): BridgeIconType | undefined {
    return this.data.icon;
  }
  get priority(): number | undefined {
    return this.data.priority;
  }
  get serialNumberSuffix(): string | undefined {
    return this.data.serialNumberSuffix;
  }
  get uniqueIdSuffix(): string | undefined {
    return this.data.uniqueIdSuffix;
  }
  get sessionMaxAgeHours(): number | undefined {
    return this.data.sessionMaxAgeHours;
  }

  /************************************************
   * Functions
   ************************************************/
  update(data: UpdateBridgeRequest) {
    if (this.id !== data.id) {
      throw new Error("ID of update request does not match bridge data id.");
    }
    Object.assign(this.data, data);
  }

  /**
   * @deprecated
   */
  withMetadata(
    status: BridgeServerStatus,
    serverNode: ServerNode,
    deviceCount: number,
    failedEntities: FailedEntity[] = [],
    exposedDeviceTypes: ExposedDeviceType[] = [],
  ) {
    const commissioning = serverNode.state.commissioning;
    const fabrics = commissioning ? values(commissioning.fabrics) : [];
    const controllerWarnings = controllerWarningsForFabrics(
      fabrics,
      exposedDeviceTypes,
    );
    return {
      id: this.id,
      name: this.name,
      filter: this.filter,
      port: this.port,
      featureFlags: this.featureFlags,
      basicInformation: this.basicInformation,
      countryCode: this.countryCode,
      icon: this.icon,
      priority: this.priority,
      serialNumberSuffix: this.serialNumberSuffix,
      uniqueIdSuffix: this.uniqueIdSuffix,
      sessionMaxAgeHours: this.sessionMaxAgeHours,
      status: status.code,
      statusReason: status.reason,
      commissioning: commissioning
        ? {
            isCommissioned: commissioning.commissioned,
            passcode: commissioning.passcode,
            discriminator: commissioning.discriminator,
            manualPairingCode: commissioning.pairingCodes.manualPairingCode,
            qrPairingCode: commissioning.pairingCodes.qrPairingCode,
            fabrics: fabrics.map((fabric) => ({
              fabricIndex: fabric.fabricIndex,
              fabricId: Number(fabric.fabricId),
              nodeId: Number(fabric.nodeId),
              rootNodeId: Number(fabric.rootNodeId),
              rootVendorId: fabric.rootVendorId,
              label: fabric.label,
            })),
          }
        : undefined,
      deviceCount,
      failedEntities: failedEntities.length > 0 ? failedEntities : undefined,
      controllerWarnings:
        controllerWarnings.length > 0 ? controllerWarnings : undefined,
    };
  }
}
