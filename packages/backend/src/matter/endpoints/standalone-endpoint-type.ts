import {
  type Behavior,
  type EndpointType,
  MutableEndpoint,
  SupportedBehaviors,
} from "@matter/main";

// matter.js behavior id for the bridged-device identity cluster.
const BRIDGED_INFO_ID = "bridgedDeviceBasicInformation";

// Rebuild an endpoint type without the bridged identity behavior. A device
// sitting at a server node root needs to look standalone, not bridged, so it
// must drop this behavior (the root node carries the identity instead). Same
// idea the hand-built server-mode vacuum type uses.
export function asStandaloneEndpointType(type: EndpointType): EndpointType {
  const behaviors = type.behaviors as Record<string, Behavior.Type>;
  if (!(BRIDGED_INFO_ID in behaviors)) {
    return type;
  }
  const kept = Object.entries(behaviors)
    .filter(([id]) => id !== BRIDGED_INFO_ID)
    .map(([, behavior]) => behavior);
  return MutableEndpoint({
    name: type.name,
    deviceType: type.deviceType,
    deviceRevision: type.deviceRevision,
    deviceClass: type.deviceClass,
    requirements: type.requirements,
    behaviors: SupportedBehaviors(...kept),
  });
}
