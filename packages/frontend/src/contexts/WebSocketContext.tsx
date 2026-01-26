import type { BridgeDataWithMetadata } from "@home-assistant-matter-hub/common";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  setBridgesFromWebSocket,
  updateBridgeFromWebSocket,
} from "../state/bridges/bridge-actions.ts";
import { useAppDispatch } from "../state/hooks.ts";

interface WebSocketMessage {
  type: "bridges_update" | "bridge_update" | "ping" | "pong";
  data?: unknown;
}

interface WebSocketContextValue {
  isConnected: boolean;
  error: Error | null;
}

const WebSocketContext = createContext<WebSocketContextValue>({
  isConnected: false,
  error: null,
});

export function useWebSocketStatus() {
  return useContext(WebSocketContext);
}

interface WebSocketProviderProps {
  children: ReactNode;
}

export function WebSocketProvider({ children }: WebSocketProviderProps) {
  const dispatch = useAppDispatch();
  const [isConnected, setIsConnected] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      switch (message.type) {
        case "bridges_update":
          dispatch(
            setBridgesFromWebSocket(message.data as BridgeDataWithMetadata[]),
          );
          break;
        case "bridge_update":
          dispatch(
            updateBridgeFromWebSocket(message.data as BridgeDataWithMetadata),
          );
          break;
        case "ping":
          wsRef.current?.send(JSON.stringify({ type: "pong" }));
          break;
      }
    },
    [dispatch],
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    // Use the base URL from the document to support Home Assistant ingress
    const base = document.querySelector("base")?.href || window.location.origin;
    const baseUrl = new URL(base);
    const wsUrl = `${protocol}//${baseUrl.host}${baseUrl.pathname}api/ws`
      .replace(/\/+/g, "/")
      .replace(":/", "://");

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

  return (
    <WebSocketContext.Provider value={{ isConnected, error }}>
      {children}
    </WebSocketContext.Provider>
  );
}
