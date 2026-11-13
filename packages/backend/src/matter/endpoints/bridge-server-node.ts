import type { BridgeData } from "@home-assistant-matter-hub/common";
import type { Environment } from "@matter/main";
import { BasicInformationServer } from "@matter/main/behaviors";
import { type Endpoint, ServerNode } from "@matter/main/node";
import { FailsafeContext } from "@matter/main/protocol";
import { createBridgeServerConfig } from "../../utils/json/create-bridge-server-config.js";

export class BridgeServerNode extends ServerNode {
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
  }

  async factoryReset() {
    await factoryResetNode(this);
  }
}

export async function factoryResetNode(node: ServerNode) {
  // erase() would run an armed failsafe's rollback on torn down datasources (#541)
  await node.env.maybeGet(FailsafeContext)?.close();
  await node.cancel();
  await node.erase();
  await renewRootUniqueId(node);
}

/**
 * Spec 11.1.5.19: UniqueID shall change on a factory reset. The config default
 * is the bridge id and survives erase(), so Alexa met a node it had already
 * deleted (#530). A value set here is persisted and outranks the default.
 */
async function renewRootUniqueId(node: ServerNode) {
  await node.setStateOf(BasicInformationServer, {
    uniqueId: BasicInformationServer.createUniqueId(),
  });
}
