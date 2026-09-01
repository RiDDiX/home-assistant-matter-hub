import type { BridgeData } from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/main";
import { type Endpoint, ServerNode } from "@matter/main/node";
import { createBridgeServerConfig } from "../../utils/json/create-bridge-server-config.js";

export class BridgeServerNode extends ServerNode {
  // Read by the patched matter.js ServerSubscription when it builds the
  // priming report (#424), see patches/@matter__node@0.17.9.patch.
  hamhOmitEventsInPriming: boolean;

  constructor(
    env: Environment,
    bridgeData: BridgeData,
    aggregator: Endpoint,
    options?: { tcp?: { incoming: boolean; outgoing: boolean } },
  ) {
    const config = createBridgeServerConfig(bridgeData, options);
    super({
      ...config,
      environment: env,
      parts: [...(config.parts ?? []), aggregator],
    });
    this.hamhOmitEventsInPriming =
      bridgeData.featureFlags?.omitEventsInPriming === true;
  }

  async factoryReset() {
    await this.cancel();
    await this.erase();
  }
}
