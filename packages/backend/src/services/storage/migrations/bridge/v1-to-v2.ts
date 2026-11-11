import type { StorageContext } from "@matter/main";

export async function migrateBridgeV1ToV2(
  storage: StorageContext,
): Promise<number> {
  // a rerun after a crash finds values already parsed
  const bridgeIdsValue = await storage.get<string | string[]>("ids", "[]");
  const bridgeIds: string[] =
    typeof bridgeIdsValue === "string"
      ? JSON.parse(bridgeIdsValue)
      : bridgeIdsValue;
  await storage.set("ids", bridgeIds);

  for (const bridgeId of bridgeIds) {
    const bridgeValue = await storage.get<string | {} | undefined>(bridgeId);
    if (bridgeValue === undefined) {
      continue;
    }
    const bridge =
      typeof bridgeValue === "string" ? JSON.parse(bridgeValue) : bridgeValue;
    bridge.compatibility = undefined;
    await storage.set(bridgeId, bridge);
  }
  return 2;
}
