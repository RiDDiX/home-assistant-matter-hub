import type { BridgeData } from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/main";
import { type Endpoint, ServerNode } from "@matter/main/node";
import { createBridgeServerConfig } from "../../utils/json/create-bridge-server-config.js";

export class BridgeServerNode extends ServerNode {
  // Used by patched ServerSubscription for priming reports (#424).
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
