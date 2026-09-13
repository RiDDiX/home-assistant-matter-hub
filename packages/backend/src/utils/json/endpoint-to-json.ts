import type { EndpointData } from "@home-assistant-matter-hub/common";
import type { Endpoint } from "@matter/main";

// plugin objects land in behavior state, never echo their credentials
const SECRET_KEY = /token|secret|password/i;

function safeClone(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value !== "object") return value;
  // past the limit a raw object would go out unredacted
  if (depth > 20) return "[truncated]";
  if (Array.isArray(value)) {
    return value.map((item) => {
      try {
        return safeClone(item, depth + 1);
      } catch {
        return null;
      }
    });
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (SECRET_KEY.test(key)) {
      result[key] = "[redacted]";
      continue;
    }
    try {
      result[key] = safeClone(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
    } catch {
      // Property getter threw (e.g. disposed Matter.js container)
    }
  }
  return result;
}

export function endpointToJson(
  endpoint: Endpoint,
  parentId?: string,
): EndpointData {
  const globalId = [parentId, endpoint.id].filter((i) => !!i).join(".");
  return {
    id: {
      global: globalId,
      local: endpoint.id,
    },
    type: {
      name: endpoint.type.name,
      id: `0x${endpoint.type.deviceType.toString(16).padStart(4, "0")}`,
    },
    endpoint: endpoint.number,
    state: safeClone(endpoint.state) as object,
    parts: endpoint.parts.map((p) => endpointToJson(p, globalId)),
  };
}
