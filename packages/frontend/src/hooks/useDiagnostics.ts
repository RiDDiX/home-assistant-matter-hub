import type {
  DiagnosticEvent,
  DiagnosticSnapshot,
  WebSocketMessage,
} from "@home-assistant-matter-hub/common";
import { useCallback, useEffect, useRef, useState } from "react";

const MAX_EVENTS = 200;

export function useDiagnostics() {
  const [events, setEvents] = useState<DiagnosticEvent[]>([]);
  const [snapshot, setSnapshot] = useState<DiagnosticSnapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const base = document.querySelector("base")?.href || window.location.origin;
    const baseUrl = new URL(base);
    const wsUrl = `${protocol}//${baseUrl.host}${baseUrl.pathname}api/ws`
      .replace(/\/+/g, "/")
      .replace(":/", "://");

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      ws.send(JSON.stringify({ type: "subscribe_diagnostics" }));
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data) as WebSocketMessage;
        if (msg.type === "diagnostic_event") {
          const evt = msg.data as DiagnosticEvent;
          setEvents((prev) => {
            const next = [...prev, evt];
            return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
          });
        } else if (msg.type === "diagnostic_snapshot") {
          const snap = msg.data as DiagnosticSnapshot;
          setSnapshot(snap);
          setEvents(snap.recentEvents ?? []);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      reconnectRef.current = setTimeout(connect, 3000);
    };

    ws.onerror = () => ws.close();
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectRef.current);
      const ws = wsRef.current;
      if (ws) {
        // no reconnect after unmount
        ws.onclose = null;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "unsubscribe_diagnostics" }));
        }
        ws.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const clearEvents = useCallback(() => setEvents([]), []);

  return { events, snapshot, connected, clearEvents };
}
