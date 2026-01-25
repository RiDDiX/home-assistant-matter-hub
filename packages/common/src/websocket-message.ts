import type { BridgeDataWithMetadata } from "./bridge-data.js";

export type WebSocketMessageType =
  | "bridges_update"
  | "bridge_update"
  | "ping"
  | "pong";

export interface WebSocketMessage {
  type: WebSocketMessageType;
  data?: BridgeDataWithMetadata | BridgeDataWithMetadata[];
  bridgeId?: string;
}
