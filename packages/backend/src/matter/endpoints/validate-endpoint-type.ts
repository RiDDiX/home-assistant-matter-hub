import { Logger } from "@matter/general";
import type { EndpointType } from "@matter/main";
import { Matter } from "@matter/main";

const logger = Logger.get("EndpointValidation");

interface ClusterValidationResult {
  deviceTypeName: string;
  deviceTypeId: number;
  missingMandatory: string[];
  availableOptional: string[];
  presentClusters: string[];
}

function toCamelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * Validate an EndpointType against the Matter spec model.
 * Checks that all mandatory server clusters are present and
 * reports which optional clusters could still be added.
 */
export function validateEndpointType(
  endpointType: EndpointType,
  entityId?: string,
): ClusterValidationResult | undefined {
  const deviceTypeModel = Matter.deviceTypes.find(
    (dt) => dt.id === endpointType.deviceType,
  );
  if (!deviceTypeModel) {
    return undefined;
  }

  const serverClusterReqs = deviceTypeModel.requirements.filter(
    (r) => r.element === "serverCluster",
  );

  const behaviorKeys = new Set(Object.keys(endpointType.behaviors));

  const missingMandatory: string[] = [];
  const availableOptional: string[] = [];
  const presentClusters: string[] = [];

  for (const req of serverClusterReqs) {
    const key = toCamelCase(req.name);
    if (behaviorKeys.has(key)) {
      presentClusters.push(req.name);
    } else if (req.isMandatory) {
      missingMandatory.push(req.name);
    } else {
      availableOptional.push(req.name);
    }
  }

  const prefix = entityId ? `[${entityId}] ` : "";

  if (missingMandatory.length > 0) {
    logger.warn(
      `${prefix}${deviceTypeModel.name} (0x${endpointType.deviceType.toString(16)}): ` +
        `missing mandatory clusters: ${missingMandatory.join(", ")}`,
    );
  }

  if (availableOptional.length > 0) {
    logger.debug(
      `${prefix}${deviceTypeModel.name} (0x${endpointType.deviceType.toString(16)}): ` +
        `optional clusters not used: ${availableOptional.join(", ")}`,
    );
  }

  return {
    deviceTypeName: deviceTypeModel.name,
    deviceTypeId: endpointType.deviceType,
    missingMandatory,
    availableOptional,
    presentClusters,
  };
}
