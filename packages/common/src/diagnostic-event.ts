export type DiagnosticEventType =
  | "state_update"
  | "command_received"
  | "entity_error"
  | "session_opened"
  | "session_closed"
  | "subscription_changed"
  | "bridge_started"
  | "bridge_stopped"
  | "entity_warning";

export interface DiagnosticEvent {
  readonly id: string;
  readonly timestamp: number;
  readonly type: DiagnosticEventType;
  readonly bridgeId?: string;
  readonly bridgeName?: string;
  readonly entityId?: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export interface DiagnosticEntityInfo {
  readonly entityId: string;
  readonly domain: string;
  readonly haState: string | null;
  readonly available: boolean;
  readonly matterClusters: string[];
  readonly autoMappings: string[];
  readonly lastUpdate: number | null;
}

export interface DiagnosticBridgeInfo {
  readonly bridgeId: string;
  readonly bridgeName: string;
  readonly status: string;
  readonly uptime: number;
  readonly entityCount: number;
  readonly sessionCount: number;
  readonly subscriptionCount: number;
  readonly featureFlags: Record<string, boolean>;
  readonly entities: DiagnosticEntityInfo[];
}

export interface DiagnosticSnapshot {
  readonly timestamp: number;
  readonly bridges: DiagnosticBridgeInfo[];
  readonly recentEvents: DiagnosticEvent[];
  readonly system: {
    readonly uptime: number;
    readonly memoryMB: number;
    readonly eventCount: number;
  };
}
