import type { EndpointData } from "@home-assistant-matter-hub/common";

export const collectLeafEndpoints = (
  endpoint: EndpointData,
): EndpointData[] => {
  const parts = endpoint.parts ?? [];
  if (parts.length === 0) {
    return [endpoint];
  }
  const leaves = parts.flatMap((part) => collectLeafEndpoints(part));

  // composed devices keep the battery on the parent, hoist it onto the primary card (#408)
  const parentPower = (endpoint.state as { powerSource?: unknown }).powerSource;
  const first = leaves[0];
  if (parentPower != null && first != null) {
    const firstPower = (first.state as { powerSource?: unknown }).powerSource;
    if (firstPower == null) {
      leaves[0] = {
        ...first,
        state: { ...first.state, powerSource: parentPower },
      };
    }
  }
  return leaves;
};
