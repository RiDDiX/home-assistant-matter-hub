import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import { useCallback, useEffect, useRef, useState } from "react";

export interface WebSocketMessage {
  type: "bridges_update" | "bridge_update" | "ping" | "pong";
  data?: unknown;
  bridgeId?: string;
}

export interface UseWebSocketResult {
  bridges: BridgeDataWithMetadata[];
  isConnected: boolean;
  error: Error | null;
}

export function useWebSocket(): UseWebSocketResult {
  const [bridges, setBridges] = useState<BridgeDataWithMetadata[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const handleMessage = useCallback((message: WebSocketMessage) => {
    switch (message.type) {
      case "bridges_update":
        setBridges(message.data as BridgeDataWithMetadata[]);
        break;
      case "bridge_update":
        setBridges((prev) => {
          const updated = message.data as BridgeDataWithMetadata;
          return prev.map((b) => (b.id === updated.id ? updated : b));
        });
        break;
      case "ping":
        wsRef.current?.send(JSON.stringify({ type: "pong" }));
        break;
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/ws`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setIsConnected(true);
        setError(null);
      };

      ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data) as WebSocketMessage;
          handleMessage(message);
        } catch {
          console.warn("Invalid WebSocket message");
        }
      };

      ws.onclose = () => {
        setIsConnected(false);
        wsRef.current = null;
        reconnectTimeoutRef.current = setTimeout(connect, 3000);
      };

      ws.onerror = () => {
        setError(new Error("WebSocket connection error"));
        ws.close();
      };
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to connect"));
    }
  }, [handleMessage]);

  useEffect(() => {
    connect();

    return () => {
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
      }
      wsRef.current?.close();
    };
  }, [connect]);

  return { bridges, isConnected, error };
}
